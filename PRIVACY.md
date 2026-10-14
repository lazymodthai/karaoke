# Privacy Policy — YouTube Karaoke

_Last updated: 2026-10-14_

YouTube Karaoke does not collect, store on any server, sell or share personal data. It has no analytics, no accounts and no backend.

**Processed on your device only.** Audio from the YouTube video you are watching is separated into stems by an AI model that runs locally in your browser (WebGPU/WebAssembly). Audio never leaves your computer.

**Stored on your device only.**
- Settings (which stems to remove, volumes, lyrics on/off, timing offset) in `chrome.storage.local`.
- Downloaded AI model files in the extension's Cache Storage.

**Network requests the extension makes.**
- `huggingface.co` / `*.hf.co`: downloads the AI model files the first time you use each model. No user data is sent.
- `lrclib.net`: when lyrics are turned on, searches for lyrics using the video's title, channel name and duration. Nothing that identifies you is sent.
- `youtube.com`: lyrics may come from the video's own captions, which the YouTube player loads the same way as when you turn captions on yourself.

**Removing data.** Uninstalling the extension deletes all of its settings and cached models.

Contact: open an issue at https://github.com/lazymodthai/karaoke/issues

---

# นโยบายความเป็นส่วนตัว (ภาษาไทย)

YouTube Karaoke ไม่เก็บ ไม่ขาย และไม่ส่งต่อข้อมูลส่วนบุคคล ไม่มีระบบวิเคราะห์ ไม่มีบัญชีผู้ใช้ และไม่มีเซิร์ฟเวอร์ของตัวเอง

- เสียงจากวิดีโอถูกแยกด้วย AI ที่รันในเบราว์เซอร์ของคุณเท่านั้น ไม่ถูกส่งออกจากเครื่อง
- การตั้งค่าเก็บใน `chrome.storage.local` และไฟล์โมเดลเก็บใน Cache Storage ของส่วนขยายบนเครื่องคุณ
- ส่วนขยายเชื่อมต่อ Hugging Face (ดาวน์โหลดโมเดล), LRCLIB (ค้นเนื้อเพลงจากชื่อคลิป ชื่อช่อง และความยาวคลิป) และ YouTube (คำบรรยายของคลิป) เท่านั้น โดยไม่ส่งข้อมูลที่ระบุตัวคุณ
- ถอนการติดตั้งแล้ว ข้อมูลทั้งหมดของส่วนขยายจะถูกลบ
