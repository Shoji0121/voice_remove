import serial

def send_serial_data(port, baud_rate, data):
    try:
        # シリアルポートを開く
        with serial.Serial(port, baud_rate, timeout=1) as ser:
            print(f"Sending data to {port} at {baud_rate} baud: {data}")
            ser.write(data)  # データを送信
            print("Data sent successfully.")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    # COMポートと設定
    port = "COM11"
    baud_rate = 115200
    data_to_send = bytes([0xAA, 0x11, 0x22, 0x33, 0xAB])  # データ: 開始 0xAA, 終了 0xAB

    send_serial_data(port, baud_rate, data_to_send)