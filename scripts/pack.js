// Builds release files into dist/:
//   youtube-karaoke-<v>.zip  — for "Load unpacked" and Chrome Web Store upload
//   youtube-karaoke-<v>.crx  — signed with the release key, for policy installs
//   updates.xml              — update manifest the .crx's update_url points to
// The key decides the extension ID, so every release must reuse the same one
// (CRX_KEY_PATH, default .keys/youtube-karaoke.pem; CI writes it from a secret).
import fs from 'node:fs';
import path from 'node:path';
import crx3 from 'crx3';

const repo = process.env.GITHUB_REPOSITORY || 'lazymodthai/karaoke';
const keyPath = path.resolve(process.env.CRX_KEY_PATH || '.keys/youtube-karaoke.pem');
const src = path.resolve('extension');
const dist = path.resolve('dist');

const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const { version } = manifest;
const name = `youtube-karaoke-${version}`;

if (!fs.existsSync(path.join(src, 'vendor/ort'))) {
  console.error('extension/vendor/ort is missing — run `npm install` first');
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  if (process.env.CI) {
    console.error(`signing key not found at ${keyPath} (set the CRX_PRIVATE_KEY secret)`);
    process.exit(1);
  }
  console.warn(`no key at ${keyPath} — generating a new one; back it up, the extension ID depends on it`);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
}

fs.rmSync(dist, { recursive: true, force: true });

function stage(dir, edit) {
  fs.cpSync(src, dir, { recursive: true, filter: (f) => path.basename(f) !== '.DS_Store' });
  const m = structuredClone(manifest);
  edit?.(m);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  return dir;
}

// The Web Store rejects manifests with update_url, so only the .crx gets one.
const storeDir = stage(path.join(dist, 'stage/store'));
const crxDir = stage(path.join(dist, 'stage/crx'), (m) => {
  m.update_url = `https://github.com/${repo}/releases/latest/download/updates.xml`;
});

await crx3([storeDir], {
  keyPath,
  crxPath: path.join(dist, 'stage/store.crx'),
  zipPath: path.join(dist, `${name}.zip`),
});
const info = await crx3([crxDir], {
  keyPath,
  crxPath: path.join(dist, `${name}.crx`),
  xmlPath: path.join(dist, 'updates.xml'),
  appVersion: version,
  crxURL: `https://github.com/${repo}/releases/download/v${version}/${name}.crx`,
});

fs.rmSync(path.join(dist, 'stage'), { recursive: true, force: true });
fs.writeFileSync(path.join(dist, 'extension-id.txt'), info.appId + '\n');
console.log(`packed v${version} → dist/ (extension ID ${info.appId})`);
