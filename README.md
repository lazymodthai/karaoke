# YouTube Karaoke (Chrome Extension)

ตัดเสียงร้องจากวิดีโอ YouTube ด้วย AI (MDX-Net "Kim_Vocal_2") ที่รันในเบราว์เซอร์ผ่าน WebGPU

## ติดตั้ง (โหมดนักพัฒนา)
1. `npm install` (จะคัดลอก onnxruntime-web ไปไว้ที่ `extension/vendor/ort/` ให้อัตโนมัติ)
2. เปิด `chrome://extensions` → เปิด **Developer mode** → **Load unpacked** → เลือกโฟลเดอร์ `extension/`
3. เปิด (หรือรีโหลด) หน้า YouTube แล้วกดปุ่มไมค์บนแถบควบคุมวิดีโอ หรือเปิดจาก popup ของส่วนขยาย

ครั้งแรกจะดาวน์โหลดโมเดล (~67MB) จาก Hugging Face แล้วเก็บไว้ใน Cache Storage ของส่วนขยาย

## การทำงาน
```
YouTube player ──appendBuffer──▶ inject.js (MAIN world: คัดลอกไบต์เสียง WebM/Opus)
                                      │ window.postMessage
                                      ▼
                                 content.js ──MessagePort──▶ engine iframe (extension origin)
                                      ▲                         webm.js     แยก init/cluster
                                      │ บล็อกเสียงที่แยกแล้ว       decodeAudioData → pcm-store.js
                                      └──────────────────────── mdx.js + onnxruntime-web (WebGPU)
```
- ดึงเสียงจากบัฟเฟอร์ของ YouTube ล่วงหน้า (ก่อนเล่นจริง) แล้วประมวลผลทีละบล็อก ~5.75 วินาที
- `content.js` เล่นเสียงดนตรีที่แยกแล้วให้ตรงกับ `video.currentTime` และปิดเสียงต้นฉบับเฉพาะช่วงที่ AI ทำเสร็จแล้ว
- โหมด "หยุดวิดีโอรอ AI": ถ้าตำแหน่งที่กำลังเล่นยังไม่เสร็จ (เริ่มเพลง/กรอเวลา) จะหยุดวิดีโอรอแล้วเล่นต่อเอง
- "เสียงร้องไกด์" ผสมเสียงร้องที่แยกได้กลับเข้าไปเบาๆ

## ทดสอบ
- `npm test` — FFT, STFT/iSTFT, WebM parser, PCM store
- `node test/model-eval.js <Kim_Vocal_2.onnx> <voice.raw> <inst.raw>` — วัดคุณภาพการแยกเสียงด้วยโมเดลจริง (f32le stereo 44.1kHz)

## ข้อจำกัด
- ต้องการ GPU ที่รองรับ WebGPU เพื่อให้ทันเวลาจริง ถ้าไม่มีจะใช้ CPU (WASM) ซึ่งช้ากว่าเวลาจริง
- รองรับเฉพาะเสียง WebM/Opus (ส่วนขยายบังคับให้ YouTube เลือก Opus)
- ไลเซนส์ของน้ำหนักโมเดล Kim_Vocal_2 (จากชุดโมเดล UVR) ควรตรวจสอบก่อนเผยแพร่เชิงพาณิชย์
