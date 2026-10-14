# ติดตั้ง YouTube Karaoke

ไฟล์ทั้งหมดอยู่ที่หน้า [Releases](https://github.com/lazymodthai/karaoke/releases/latest)

> **ทำไมดับเบิลคลิกไฟล์ `.crx` แล้วติดตั้งไม่ได้?**
> Chrome (และ Edge / Brave) บน Windows กับ macOS ไม่ยอมติดตั้ง `.crx` ที่ไม่ได้มาจาก Chrome Web Store
> จะขึ้น `CRX_REQUIRED_PROOF_MISSING` หรือติดตั้งแล้วถูกปิดไว้ ไฟล์ `.crx` จึงใช้ได้เฉพาะการติดตั้งผ่าน policy (วิธีที่ 3)

## วิธีที่ 1: Load unpacked (ใช้ได้ทุกเครื่อง)
1. ดาวน์โหลด `youtube-karaoke-<เวอร์ชัน>.zip` แล้วแตกไฟล์ไว้ในโฟลเดอร์ที่จะไม่ลบทิ้ง (Chrome โหลดจากโฟลเดอร์นี้ทุกครั้งที่เปิด)
2. เปิด `chrome://extensions` แล้วเปิด **Developer mode** มุมขวาบน
3. กด **Load unpacked** แล้วเลือกโฟลเดอร์ที่แตกไว้ (โฟลเดอร์ที่มีไฟล์ `manifest.json`)
4. รีโหลดหน้า YouTube แล้วกดปุ่มไมค์บนแถบควบคุมวิดีโอ

**อัปเดตเวอร์ชัน:** แตกไฟล์ zip ใหม่ทับโฟลเดอร์เดิม แล้วกดปุ่มรีโหลด (⟳) ที่การ์ดของส่วนขยายใน `chrome://extensions`
การตั้งค่าและโมเดลที่ดาวน์โหลดไว้จะยังอยู่ ตราบใดที่ใช้โฟลเดอร์เดิม

## วิธีที่ 2: Chrome Web Store
ถ้ามีลิงก์ Web Store ใน README หรือในหน้า Release ให้กด **Add to Chrome** ได้เลย ส่วนขยายจะอัปเดตเองอัตโนมัติ

## วิธีที่ 3: ไฟล์ `.crx` ผ่าน policy (สำหรับผู้ดูแลระบบ)
ใช้ policy `ExtensionInstallForcelist` ชี้ไปที่ `updates.xml` ของ release ล่าสุด Chrome จะดาวน์โหลด `.crx` ติดตั้ง และอัปเดตให้เอง

```
<EXTENSION_ID>;https://github.com/lazymodthai/karaoke/releases/latest/download/updates.xml
```

ดู `<EXTENSION_ID>` ได้ในหน้า Release (บรรทัด "Extension ID ของไฟล์ .crx")

ข้อจำกัดของ Chrome: บน **Windows และ macOS** การบังคับติดตั้งส่วนขยายที่ไม่ได้มาจาก Web Store จะทำได้ก็ต่อเมื่อเครื่องอยู่ภายใต้การจัดการ
(Windows เข้า Active Directory domain, macOS ลงทะเบียน MDM หรือทั้งสองระบบใช้ Chrome Enterprise Core / Chrome Browser Cloud Management ซึ่งใช้ฟรี)
**Linux** ใช้ได้เลยไม่ต้องมีการจัดการเครื่อง

**Linux** สร้างไฟล์ `/etc/opt/chrome/policies/managed/youtube-karaoke.json` (Chromium ใช้ `/etc/chromium/policies/managed/`)
```json
{
  "ExtensionInstallForcelist": [
    "<EXTENSION_ID>;https://github.com/lazymodthai/karaoke/releases/latest/download/updates.xml"
  ]
}
```

**Windows (เครื่องที่อยู่ภายใต้การจัดการ)** บันทึกเป็นไฟล์ `.reg` แล้วดับเบิลคลิก
```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist]
"1"="<EXTENSION_ID>;https://github.com/lazymodthai/karaoke/releases/latest/download/updates.xml"
```

**macOS (เครื่องที่ลงทะเบียน MDM)** ใส่ค่าใน configuration profile ของโดเมน `com.google.Chrome`
```xml
<key>ExtensionInstallForcelist</key>
<array>
  <string>&lt;EXTENSION_ID&gt;;https://github.com/lazymodthai/karaoke/releases/latest/download/updates.xml</string>
</array>
```

**Chrome Enterprise Core:** Admin console → Chrome browser → Apps & extensions → **+** → *Add Chrome app or extension by ID*
→ ใส่ ID แล้วเลือก *From a custom URL* ใส่ URL ของ `updates.xml` ข้างบน

ตรวจสอบได้ที่ `chrome://policy` แล้วกด **Reload policies** ส่วนขยายจะติดตั้งภายในไม่กี่นาที (ผู้ใช้ลบเองไม่ได้จนกว่าจะเอา policy ออก)
