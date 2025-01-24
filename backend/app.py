from flask import Flask, request, send_file, jsonify
from flask_cors import CORS
import os
from werkzeug.utils import secure_filename
import numpy as np
import librosa
import soundfile as sf
from sklearn.mixture import GaussianMixture
from moviepy.editor import VideoFileClip
import ffmpeg
import joblib

# Google IDトークン検証に使用
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

app = Flask(__name__)
CORS(app)

UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# フレームベースの音声処理パラメータ
FRAME_SIZE = 512
HOP_LENGTH = 256
N_MFCC = 13

# デフォルトモデル
DEFAULT_MODEL_PATH = os.path.join(UPLOAD_FOLDER, "voice_model.pkl")
gmm_model_default = None  # メモリ上でキャッシュ

CLIENT_ID = "<YOUR_GOOGLE_OAUTH_CLIENT_ID>.apps.googleusercontent.com"
    # ↑ Google Cloud Console で作成したOAuthクライアントID

def get_model_path(user_id: str) -> str:
    """
    user_id が空ならデフォルトモデル、そうでなければ `voice_model_{user_id}.pkl`
    """
    if user_id:
        return os.path.join(UPLOAD_FOLDER, f"voice_model_{user_id}.pkl")
    else:
        return DEFAULT_MODEL_PATH

# ------------------------------
# 1. Googleログイン用エンドポイント
# ------------------------------
@app.route("/auth/google", methods=["POST"])
def google_login():
    """
    フロントから受け取った Google IDトークンを検証し、
    OKなら `sub` (Googleが一意に割り当てるユーザーID) を返す。
    """
    data = request.json
    if not data or "idToken" not in data:
        return jsonify({"error": "No idToken provided"}), 400

    id_token_str = data["idToken"]

    try:
        # IDトークンを検証
        # audience=CLIENT_ID と一致するかチェックが必要
        idinfo = id_token.verify_oauth2_token(
            id_token_str,
            google_requests.Request(),
            CLIENT_ID
        )
        # ユーザーを一意に識別するID
        user_sub = idinfo["sub"]
        # user_email = idinfo["email"]  # 必要に応じて使う
        return jsonify({"userId": user_sub}), 200
    except ValueError as e:
        # トークン無効
        return jsonify({"error": str(e)}), 401

# ------------------------------
# 2. 学習関連
# ------------------------------
def train_model(audio_path: str, model_path: str) -> GaussianMixture:
    """
    音声ファイルを読み込み、GMM を学習し model_path に保存して返す
    """
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    mfcc = librosa.feature.mfcc(
        y=y, sr=sr, n_mfcc=N_MFCC, 
        n_fft=FRAME_SIZE, hop_length=HOP_LENGTH
    ).T

    gmm = GaussianMixture(n_components=1, covariance_type='diag', random_state=42)
    gmm.fit(mfcc)

    joblib.dump(gmm, model_path)
    return gmm

def remove_my_voice(video_path: str, output_path: str, model: GaussianMixture) -> str:
    """
    モデル model を使って動画の音声から「自分の声」を逆位相で打ち消し、
    処理後動画を output_path に書き出す
    """
    # 動画から音声抽出
    video = VideoFileClip(video_path)
    audio = video.audio
    temp_audio_path = os.path.join(UPLOAD_FOLDER, "temp_audio.wav")
    audio.write_audiofile(temp_audio_path, codec="pcm_s16le")

    # 音声を読み込み、MFCC
    y, sr = librosa.load(temp_audio_path, sr=None, mono=True)
    mfcc = librosa.feature.mfcc(
        y=y, sr=sr, n_mfcc=N_MFCC, 
        n_fft=FRAME_SIZE, hop_length=HOP_LENGTH
    ).T

    # スコア計算
    threshold = -50
    scores = model.score_samples(mfcc)
    is_my_voice_mask = (scores > threshold)

    processed_audio = y.copy()
    num_frames = len(mfcc)
    for i in range(num_frames):
        start_sample = i * HOP_LENGTH
        end_sample = min(start_sample + FRAME_SIZE, len(processed_audio))
        if is_my_voice_mask[i]:
            processed_audio[start_sample:end_sample] = -processed_audio[start_sample:end_sample]

    # 保存
    processed_audio_path = os.path.join(UPLOAD_FOLDER, "processed_audio.wav")
    sf.write(processed_audio_path, processed_audio, sr)

    full_output = os.path.join(UPLOAD_FOLDER, output_path)
    (
        ffmpeg
        .input(video_path)
        .audio
        .input(processed_audio_path)
        .output(full_output, vcodec="copy", acodec="aac", strict='experimental')
        .run(overwrite_output=True)
    )
    return full_output

@app.route("/train", methods=["POST"])
def train():
    """
    userId があれば 個別モデル、なければデフォルトモデル
    """
    if "file" not in request.files:
        return jsonify({"error": "No training audio file provided"}), 400
    audio_file = request.files["file"]
    audio_path = os.path.join(UPLOAD_FOLDER, secure_filename(audio_file.filename))
    audio_file.save(audio_path)

    user_id = request.form.get("userId", "").strip()
    model_path = get_model_path(user_id)

    try:
        gmm = train_model(audio_path, model_path)
        # デフォルトモデルならメモリキャッシュ
        if not user_id:
            global gmm_model_default
            gmm_model_default = gmm
        return jsonify({"message": f"Training successful for userId='{user_id or 'default'}'"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/process", methods=["POST"])
def process():
    """
    userId があれば個別モデル、なければデフォルトモデル
    """
    if "videoFile" not in request.files:
        return jsonify({"error": "No video file provided"}), 400
    video_file = request.files["videoFile"]
    video_path = os.path.join(UPLOAD_FOLDER, secure_filename(video_file.filename))
    video_file.save(video_path)

    user_id = request.form.get("userId", "").strip()
    model_path = get_model_path(user_id)

    # モデル読み込み
    if user_id:
        if not os.path.exists(model_path):
            return jsonify({"error": f"No model found for userId='{user_id}'"}), 400
        gmm_model = joblib.load(model_path)
    else:
        global gmm_model_default
        if (gmm_model_default is None) and os.path.exists(DEFAULT_MODEL_PATH):
            gmm_model_default = joblib.load(DEFAULT_MODEL_PATH)
        if gmm_model_default is None:
            return jsonify({"error": "No default model found. Please train first."}), 400
        gmm_model = gmm_model_default

    try:
        result_path = remove_my_voice(video_path, "output_video.mp4", gmm_model)
        return send_file(result_path, as_attachment=True)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    # サーバ起動時にデフォルトモデルがあればロード
    if os.path.exists(DEFAULT_MODEL_PATH):
        gmm_model_default = joblib.load(DEFAULT_MODEL_PATH)
    app.run(debug=True)
