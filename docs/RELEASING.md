# ปล่อยเวอร์ชันใหม่

## ขั้นตอนปกติ
1. แก้ `"version"` ใน `extension/manifest.json` (เช่น `0.4.1`) แล้ว commit
2. `git tag v0.4.1 && git push origin main --tags`
3. GitHub Actions (`.github/workflows/release.yml`) จะรันเทสต์ สร้างไฟล์ แล้วสร้าง Release ที่มี
   - `youtube-karaoke-<v>.zip`: สำหรับ Load unpacked และอัปโหลดขึ้น Web Store
   - `youtube-karaoke-<v>.crx`: เซ็นด้วยคีย์ของโปรเจกต์ ใส่ `update_url` ไว้แล้ว
   - `updates.xml`: update manifest ที่ policy ใช้ (`releases/latest/download/updates.xml` ชี้ไปที่ release ล่าสุดเสมอ)
4. ถ้าตั้ง secret `CWS_*` ไว้แล้ว ระบบจะอัปโหลด zip ขึ้น Chrome Web Store และส่งรีวิวให้อัตโนมัติ

ถ้า tag ไม่ตรงกับเวอร์ชันใน manifest workflow จะหยุดทำงานและไม่สร้าง Release

สร้างไฟล์บนเครื่องตัวเองได้ด้วย `npm run pack` (ไฟล์ออกที่ `dist/`)

## คีย์สำหรับเซ็น `.crx`
- คีย์เป็นตัวกำหนด Extension ID ถ้าคีย์หายหรือเปลี่ยน ID จะเปลี่ยน และเครื่องที่ติดตั้งผ่าน policy จะไม่ได้รับอัปเดต
- คีย์อยู่ที่ `.keys/youtube-karaoke.pem` (อยู่ใน `.gitignore` ห้าม commit) และอยู่ใน GitHub secret `CRX_PRIVATE_KEY`
- **ให้สำรองไฟล์นี้ไว้ในที่ปลอดภัย** เช่น password manager เพราะ GitHub secret อ่านค่าย้อนกลับไม่ได้
- ตั้ง secret ใหม่ได้ด้วย `gh secret set CRX_PRIVATE_KEY < .keys/youtube-karaoke.pem`

## ตั้งค่า Chrome Web Store (ทำครั้งเดียว)
1. สมัคร [Chrome Web Store developer](https://chrome.google.com/webstore/devconsole) (ค่าธรรมเนียม $5 ครั้งเดียว) และยืนยันอีเมลติดต่อ
2. กด **New item** แล้วอัปโหลด `youtube-karaoke-<v>.zip` จาก Release ด้วยมือในครั้งแรก
3. กรอกข้อมูลตามหัวข้อ "ข้อมูลสำหรับหน้า Store" ด้านล่าง
   - Visibility: เลือก **Unlisted** ถ้าต้องการแจกเฉพาะคนที่มีลิงก์ หรือ **Public**
   - Privacy policy URL: `https://github.com/lazymodthai/karaoke/blob/main/PRIVACY.md`
   - Screenshots (1280×800): `docs/images/store/screenshot-1.png`, `screenshot-2.png`
   - Small promo tile (440×280): `docs/images/store/promo-tile.png`
   - Store icon: `extension/icons/icon-128.png`
   - สร้างรูปใหม่ได้จาก `docs/images/src/store.html` (คำสั่งอยู่ในคอมเมนต์ด้านบนของไฟล์)
4. กด **Submit for review**
5. หลังจากนั้นสร้าง OAuth credentials ตาม [คู่มือนี้](https://github.com/fregante/chrome-webstore-upload-keys) แล้วตั้ง secret
   ```sh
   gh secret set CWS_EXTENSION_ID     # ID ของ item ใน Web Store (ไม่ตรงกับ ID ของ .crx)
   gh secret set CWS_PUBLISHER_ID     # อยู่ในหน้า Account ของ developer dashboard
   gh secret set CWS_CLIENT_ID
   gh secret set CWS_CLIENT_SECRET
   gh secret set CWS_REFRESH_TOKEN
   ```
   ตั้งแล้ว ทุก tag ใหม่จะอัปโหลดและส่งรีวิวให้อัตโนมัติ
6. ใส่ลิงก์ Web Store ใน README

Web Store จะเซ็นไฟล์ใหม่ด้วยคีย์ของ Google เอง Extension ID ใน Store จึงต่างจาก ID ของไฟล์ `.crx` ใน GitHub Release ทั้งสองแบบใช้คู่กันได้

### ข้อมูลสำหรับหน้า Store

**Single purpose**
> Removes vocals and/or instruments (guitar, drums, bass) from the YouTube video being played, using an on-device AI model, so users can sing karaoke or practise along, with optional synced lyrics.

**เหตุผลที่ขอสิทธิ์ (Permission justification)**
- `storage`: saves the user's settings (stems to remove, volumes, lyrics options).
- Host `huggingface.co`, `*.hf.co`: downloads the AI model files (ONNX) the first time each model is used. Models are data only; all executable code ships inside the package.
- Content scripts on `youtube.com` / `music.youtube.com`: read the audio the YouTube player is already buffering, play the separated track in sync with the video, and draw the karaoke controls and lyrics.

**Remote code:** No. onnxruntime-web is bundled in `vendor/ort/`. Only model weights are downloaded.

**Data usage:** no user data is collected (ติ๊กว่าไม่เก็บข้อมูลทุกหมวด และยืนยันทั้ง 3 ข้อ certification)

**คำอธิบาย (ภาษาไทย)**
> ตัดเสียงร้อง กีตาร์ กลอง หรือเบส ออกจากวิดีโอ YouTube แบบเรียลไทม์ด้วย AI ที่ทำงานในเครื่องของคุณ (WebGPU) เพื่อร้องคาราโอเกะหรือซ้อมดนตรีตามเพลงจริง
> • เลือกตัดได้หลายส่วนพร้อมกัน (โมเดล MDX-Net และ HT-Demucs 6 stems)
> • เสียงร้องไกด์: ผสมเสียงร้องต้นฉบับกลับเข้าไปเบาๆ
> • เนื้อเพลงแบบตู้คาราโอเกะ พร้อมแถบสีวิ่งตามจังหวะ
> • เสียงไม่ถูกส่งออกจากเครื่อง ไม่มีการเก็บข้อมูลผู้ใช้

### ความเสี่ยงตอนรีวิว
- ส่วนขยายนี้แก้ไขเสียงของ YouTube ผู้รีวิวอาจถามเรื่องการละเมิดข้อกำหนดของ YouTube หรือลิขสิทธิ์ ให้ยืนยันว่าประมวลผลเฉพาะสิ่งที่ผู้ใช้กำลังเล่นอยู่ ไม่ดาวน์โหลดหรือบันทึกเสียงหรือวิดีโอเก็บไว้
- ควรตรวจสอบไลเซนส์ของโมเดล Kim_Vocal_2 ก่อนเปิดเป็น Public (ดูหัวข้อข้อจำกัดใน README)
