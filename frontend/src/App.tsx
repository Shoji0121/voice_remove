import React, { useState, useRef } from "react";
import axios from "axios";
import "./App.css";

/**
 * ファイルサイズ上限 (byte)
 *  - 音声 20MB
 *  - 動画 200MB
 */
const MAX_AUDIO_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_VIDEO_SIZE = 200 * 1024 * 1024; // 200MB

/**
 * バリデーション用のファイル拡張子
 */
const ALLOWED_AUDIO_EXTS = [".wav", ".mp3", ".m4a"];
const ALLOWED_VIDEO_EXTS = [".mp4"];

const App: React.FC = () => {
  // ------------------------------
  // ステート管理
  // ------------------------------
  const [currentStep, setCurrentStep] = useState<number>(1);

  // 録音管理
  const [recording, setRecording] = useState<boolean>(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // ファイルアップロード管理
  const [trainingFile, setTrainingFile] = useState<File | null>(null);
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);

  // 処理状態と結果
  const [processing, setProcessing] = useState<boolean>(false);
  const [processedVideo, setProcessedVideo] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // ユーザーID (将来の拡張用、空ならデフォルト)
  const [userId, setUserId] = useState<string>("");

  // エラーメッセージ
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ------------------------------
  // スピナー (学習/処理中)
  // ------------------------------
  const Spinner = () => (
    <div className="spinner-overlay">
      <div className="spinner"></div>
      <p>Processing...</p>
    </div>
  );

  // ------------------------------
  // 録音機能
  // ------------------------------
  const startRecording = async () => {
    if (recording) return;
    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = () => {
        // Blob から File を作成
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/wav" });
        const newFile = new File([audioBlob], "recording.wav", { type: "audio/wav" });

        // サーバー送信用にファイルを保持
        setTrainingFile(newFile);

        // ダウンロード／再生用に Blob URL を生成
        const newAudioUrl = URL.createObjectURL(audioBlob);
        setAudioUrl(newAudioUrl);
      };

      mediaRecorder.start();
      setRecording(true);
    } catch (error) {
      console.error("Could not start recording:", error);
      setErrorMsg("Could not access microphone. Please check permissions.");
    }
  };

  const stopRecording = () => {
    if (!mediaRecorderRef.current) return;
    mediaRecorderRef.current.stop();
    setRecording(false);
  };

  // ------------------------------
  // ファイルチェック
  // ------------------------------
  const getFileExtension = (fileName: string) => {
    const idx = fileName.lastIndexOf(".");
    return idx >= 0 ? fileName.slice(idx).toLowerCase() : "";
  };

  const handleFileValidation = (file: File, allowedExts: string[], maxSize: number) => {
    const ext = getFileExtension(file.name);
    if (!allowedExts.includes(ext)) {
      throw new Error(`Invalid file type. Allowed: ${allowedExts.join(", ")}`);
    }
    if (file.size > maxSize) {
      throw new Error(`File size exceeds limit of ${maxSize / (1024 * 1024)} MB`);
    }
  };

  // ------------------------------
  // ファイル選択ハンドラ
  // ------------------------------
  const handleTrainingUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setErrorMsg(null);
      const file = e.target.files[0];
      try {
        handleFileValidation(file, ALLOWED_AUDIO_EXTS, MAX_AUDIO_SIZE);
        setTrainingFile(file);
        setAudioUrl(null); // 録音済みURLをクリア
      } catch (err) {
        setErrorMsg((err as Error).message);
        e.target.value = "";
      }
    }
  };

  const handleVoiceUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setErrorMsg(null);
      const file = e.target.files[0];
      try {
        handleFileValidation(file, ALLOWED_AUDIO_EXTS, MAX_AUDIO_SIZE);
        setVoiceFile(file);
      } catch (err) {
        setErrorMsg((err as Error).message);
        e.target.value = "";
      }
    }
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setErrorMsg(null);
      const file = e.target.files[0];
      try {
        handleFileValidation(file, ALLOWED_VIDEO_EXTS, MAX_VIDEO_SIZE);
        setVideoFile(file);
      } catch (err) {
        setErrorMsg((err as Error).message);
        e.target.value = "";
      }
    }
  };

  // ------------------------------
  // (1) モデル学習
  // ------------------------------
  const trainModel = async () => {
    if (!trainingFile) {
      alert("Please provide a training file (recording or upload).");
      return;
    }

    setProcessing(true);
    setErrorMsg(null);

    try {
      const formData = new FormData();
      formData.append("file", trainingFile);
      formData.append("userId", userId); // 空ならデフォルト

      const response = await axios.post("http://127.0.0.1:5000/train", formData);

      if (response.status === 200) {
        alert(response.data.message || "Training completed!");
        setCurrentStep(2);
      } else {
        alert("Unexpected response. Check the console/logs.");
      }
    } catch (error: any) {
      console.error("Error training model:", error);
      if (error.response) {
        setErrorMsg(`Server Error: ${error.response.data.error || error.response.data}`);
      } else {
        setErrorMsg("Network error. Could not train model.");
      }
    } finally {
      setProcessing(false);
    }
  };

  // スキップ学習
  const skipTraining = () => {
    // 既存モデルありきでステップ2へ
    setCurrentStep(2);
  };

  // ------------------------------
  // (2) 動画処理
  // ------------------------------
  const processVideo = async () => {
    if (!videoFile) {
      alert("Please upload a video file.");
      return;
    }

    setProcessing(true);
    setErrorMsg(null);

    try {
      const formData = new FormData();
      formData.append("userId", userId); // 空ならデフォルトモデル
      if (voiceFile) {
        formData.append("voiceFile", voiceFile);
      }
      formData.append("videoFile", videoFile);

      const response = await axios.post("http://127.0.0.1:5000/process", formData, {
        responseType: "blob",
      });

      if (response.status === 200) {
        const videoUrl = URL.createObjectURL(response.data);
        setProcessedVideo(videoUrl);
        setCurrentStep(3);
      } else {
        alert("Unexpected response. Check the console/logs.");
      }
    } catch (error: any) {
      console.error("Error processing video:", error);
      if (error.response) {
        setErrorMsg(`Server Error: ${error.response.data.error || error.response.data}`);
      } else {
        setErrorMsg("Network error. Could not process video.");
      }
    } finally {
      setProcessing(false);
    }
  };

  // ------------------------------
  // ダウンロード録音ファイル
  // ------------------------------
  const downloadRecording = () => {
    if (!audioUrl) return;
    const link = document.createElement("a");
    link.href = audioUrl;
    link.download = "recording.wav";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ------------------------------
  // ステップUI
  // ------------------------------
  const renderStep1 = () => (
    <div className="card">
      <h2>Step 1: Train or Skip</h2>
      <p className="description">
        You can record or upload an audio file to train a new model.<br/>
        Or skip training if the default model (or your userId model) is already trained.
      </p>

      <div className="user-id-container">
        <label>User ID (optional):</label>
        <input
          type="text"
          placeholder="Leave blank for default"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
      </div>

      <div className="recording-controls">
        <button onClick={startRecording} disabled={recording}>
          {recording ? "Recording..." : "Start Recording"}
        </button>
        <button onClick={stopRecording} disabled={!recording}>
          Stop
        </button>
      </div>

      {audioUrl && (
        <div className="audio-player">
          <audio controls src={audioUrl}></audio>
          <button onClick={downloadRecording} style={{ marginTop: "10px" }}>
            Download Recording
          </button>
        </div>
      )}

      <div className="upload-container">
        <label>Or Upload an Audio File:</label>
        <input type="file" accept="audio/*" onChange={handleTrainingUpload} />
      </div>

      <div style={{ marginTop: "15px" }}>
        <button onClick={trainModel} disabled={processing}>
          {processing ? "Training..." : "Train Model"}
        </button>
        <button onClick={skipTraining} disabled={processing} style={{ marginLeft: "10px" }}>
          Use Existing Model (Skip Training)
        </button>
      </div>
    </div>
  );

  const renderStep2 = () => (
    <div className="card">
      <h2>Step 2: Upload Video</h2>
      <p className="description">
        Upload an optional voice file for reference and the video you want to process.
      </p>

      <div className="user-id-container">
        <label>User ID (optional, must match training if used):</label>
        <input
          type="text"
          placeholder="Leave blank for default"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
      </div>

      <div className="upload-container">
        <label>Optional Voice File:</label>
        <input type="file" accept="audio/*" onChange={handleVoiceUpload} />
      </div>

      <div className="upload-container">
        <label>Video File (required):</label>
        <input type="file" accept="video/mp4" onChange={handleVideoUpload} />
      </div>

      <button onClick={processVideo} disabled={processing}>
        {processing ? "Processing..." : "Process Video"}
      </button>

      <div className="nav-buttons">
        <button onClick={() => setCurrentStep(1)} className="back-btn">
          ← Back
        </button>
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div className="card">
      <h2>Step 3: Download Processed Video</h2>
      <p className="description">Your video is ready. Download below!</p>

      {processedVideo && (
        <>
          <video
            className="video-preview"
            src={processedVideo}
            controls
            style={{ width: "100%", maxWidth: "600px" }}
          ></video>
          <div>
            <a href={processedVideo} download="output_video.mp4" className="download-link">
              Download Processed Video
            </a>
          </div>
        </>
      )}
      <div className="nav-buttons">
        <button onClick={() => setCurrentStep(2)} className="back-btn">
          ← Back
        </button>
      </div>
    </div>
  );

  return (
    <div className="app-container">
      {processing && <Spinner />}
      <header className="app-header">
        <h1>Voice Removal Service</h1>
      </header>

      <main className="main-content">
        {errorMsg && <div className="error-box">{errorMsg}</div>}

        {currentStep === 1 && renderStep1()}
        {currentStep === 2 && renderStep2()}
        {currentStep === 3 && renderStep3()}
      </main>
    </div>
  );
};

export default App;
