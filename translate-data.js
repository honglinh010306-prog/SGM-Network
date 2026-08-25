/**
 * translate-data.js
 * Tự động dịch dữ liệu nguồn sang ItemsData_vn.json
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Config ──────────────────────────────────────
const EN_FILE   = path.join(__dirname, 'ItemsData_en.json');
const VN_FILE   = path.join(__dirname, 'ItemsData_vn.json');
const NEW_ITEMS_FILE = path.join(__dirname, 'new_items.json');

const CONCURRENCY = 16;
const RETRY_MAX   = 4;
const RETRY_BASE  = 400;

const GLOSSARY_EN = {
  vi: {
    'Top': '__TOP__',
    'Bottom': '__BOTTOM__',
    'Shoes': '__SHOES__',
    'Head': '__HEAD__',
    'Facepaint': '__FACEPAINT__',
    'Mask': '__MASK__',
  }
};

const GLOSSARY_TRANSLATIONS = {
  vi: {
    '__TOP__': 'Áo',
    '__BOTTOM__': 'Quần',
    '__SHOES__': 'Giày',
    '__HEAD__': 'Tóc',
    '__FACEPAINT__': 'Vẽ Mặt',
    '__MASK__': 'Mặt Nạ',
  }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isOB55Item(item) {
  const tag = String(item.Tag || '').toUpperCase();
  const category = String(item.Category || '').toUpperCase();
  const name = String(item.Name || '').toUpperCase();
  return tag.includes('OB55') || category.includes('OB55') || name.includes('OB55');
}

function applyGlossary(text, lang) {
  const glossary = GLOSSARY_EN[lang];
  if (!glossary) return text;
  let result = text;
  for (const [en, placeholder] of Object.entries(glossary)) {
    const regex = new RegExp('\\b' + en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
    result = result.replace(regex, placeholder);
  }
  return result;
}

function restoreGlossary(text, lang) {
  const translations = GLOSSARY_TRANSLATIONS[lang];
  if (!translations) return text;
  let result = text;
  for (const [placeholder, translation] of Object.entries(translations)) {
    result = result.split(placeholder).join(translation);
  }
  return result;
}

// ── Google Translate ─────
function translateText(text, targetLang) {
  return new Promise((resolve, reject) => {
    if (!text || !text.trim()) { resolve(''); return; }

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${
      encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;

    const req = https.get(url, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          let out = '';
          if (parsed?.[0]) for (const seg of parsed[0]) if (seg?.[0]) out += seg[0];
          resolve(out || null);
        } catch { reject(new Error('parse_error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function translate(text, lang) {
  for (let i = 0; i < RETRY_MAX; i++) {
    try {
      const res = await translateText(text, lang);
      if (res !== null) return res;
    } catch (e) {
      if (i < RETRY_MAX - 1) await sleep(RETRY_BASE * Math.pow(2, i));
    }
  }
  return null; // Trả về null nếu lỗi để đánh dấu dịch thất bại
}

async function pool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Xử lý một ngôn ngữ ──────────────────────────
async function processLanguage(enData, existingData, targetLang, outputFile, label, force = false) {
  console.log(`\n🌐 ${label} (${targetLang})`);

  const existingMap = new Map(existingData.map(i => [i.Id, i]));
  const PENDING = '\u0000__PENDING__\u0000';

  const toProcess = [];

  for (const en of enData) {
    const ex = existingMap.get(en.Id);
    if (!ex) {
      toProcess.push({ en, ex: null, needName: !!en.Name?.trim(), needDesc: !!en.Desc?.trim(), isNew: true });
    } else if (force) {
      toProcess.push({ en, ex, needName: !!en.Name?.trim(), needDesc: !!en.Desc?.trim(), isNew: false });
    } else {
      const sourceName = ex._enName ?? PENDING;
      const sourceDesc = ex._enDesc ?? PENDING;

      // Tự động phát hiện nếu bị kẹt Tiếng Anh hoặc chưa được dịch
      const isNameUntranslated = !!en.Name?.trim() && (!ex.Name?.trim() || ex.Name === en.Name || sourceName === PENDING);
      const isDescUntranslated = !!en.Desc?.trim() && (!ex.Desc?.trim() || ex.Desc === en.Desc || sourceDesc === PENDING);

      const nameChanged = en.Name !== sourceName;
      const descChanged = en.Desc !== sourceDesc;

      const needName = isNameUntranslated || nameChanged;
      const needDesc = isDescUntranslated || descChanged;

      if (needName || needDesc) {
        toProcess.push({ en, ex, needName, needDesc, isNew: false });
      }
    }
  }

  const toTranslate = toProcess.filter(t => t.needName || t.needDesc);
  const newItems = toProcess.filter(t => t.isNew).length;
  const updatedItems = toProcess.filter(t => !t.isNew).length;
  const unchanged = enData.length - toProcess.length;

  console.log(`   Mới: ${newItems} | Cập nhật: ${updatedItems} | Giữ nguyên: ${unchanged}`);

  let done = 0;
  const translated = new Map();

  function commonFields(en) {
    return {
      Id: en.Id, Type: en.Type, CollectionType: en.CollectionType,
      Icon: en.Icon, Rare: en.Rare, IsUnique: en.IsUnique, IconInAB: en.IconInAB,
      Category: en.Category ?? '', Tag: en.Tag ?? '',
    };
  }

  function buildResult() {
    return enData.map(en => {
      const ex = existingMap.get(en.Id);
      const tr = translated.get(en.Id);
      if (tr) {
        return {
          ...commonFields(en),
          Name: tr.Name,
          Desc: tr.Desc,
          _enName: tr.successName ? en.Name : PENDING,
          _enDesc: tr.successDesc ? en.Desc : PENDING
        };
      }
      if (ex) {
        return {
          ...commonFields(en),
          Name: ex.Name ?? '',
          Desc: ex.Desc ?? '',
          _enName: ex._enName ?? PENDING,
          _enDesc: ex._enDesc ?? PENDING
        };
      }
      return { ...commonFields(en), Name: '', Desc: '', _enName: PENDING, _enDesc: PENDING };
    });
  }

  let lastCheckpoint = Date.now();
  function checkpointSave(force = false) {
    const now = Date.now();
    if (!force && now - lastCheckpoint < 20000) return;
    lastCheckpoint = now;
    try {
      fs.writeFileSync(outputFile, JSON.stringify(buildResult(), null, 2), 'utf-8');
    } catch (e) {}
  }

  const tasks = toTranslate.map(({ en, ex, needName, needDesc }) => async () => {
    const result = {
      Name: ex?.Name ?? '',
      Desc: ex?.Desc ?? '',
      successName: !needName,
      successDesc: !needDesc
    };

    if (needName) {
      const res = await translate(applyGlossary(en.Name, targetLang), targetLang);
      if (res) {
        result.Name = restoreGlossary(res, targetLang);
        result.successName = true;
      }
    }

    if (needDesc) {
      const res = await translate(applyGlossary(en.Desc, targetLang), targetLang);
      if (res) {
        result.Desc = restoreGlossary(res, targetLang);
        result.successDesc = true;
      }
    }

    translated.set(en.Id, result);
    done++;
    if (done % 200 === 0 || done === toTranslate.length) {
      console.log(`   [${targetLang}] Đã dịch: ${done}/${toTranslate.length}`);
    }
    checkpointSave();
  });

  if (tasks.length > 0) {
    await pool(tasks, CONCURRENCY);
  }

  const result = buildResult();
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`   ✅ Ghi ${result.length} items → ${path.basename(outputFile)}`);
  return { total: result.length, translated: toTranslate.length, unchanged };
}

function writeNewItemsFile(enData, vnData) {
  try {
    const existingIds = new Set(vnData.map(i => i.Id.toString()));
    const newIds = enData.filter(en => !existingIds.has(en.Id.toString())).map(en => en.Id.toString());
    fs.writeFileSync(NEW_ITEMS_FILE, JSON.stringify(newIds), 'utf-8');
    console.log(`   🆕 ${newIds.length} vật phẩm mới → ${path.basename(NEW_ITEMS_FILE)}`);
  } catch (e) {}
}

async function watchMode() {
  console.log('👁️  Watch mode: theo dõi ItemsData_en.json...');

  const run = async () => {
    try {
      if (!fs.existsSync(EN_FILE)) return;

      const rawEnData = JSON.parse(fs.readFileSync(EN_FILE, 'utf-8'));
      const enData = rawEnData.filter(item => !isOB55Item(item));
      const hiddenCount = rawEnData.length - enData.length;
      if (hiddenCount > 0) console.log(`🙈 Đã tạm ẩn ${hiddenCount} vật phẩm thuộc OB55.`);

      const vnData = fs.existsSync(VN_FILE) ? JSON.parse(fs.readFileSync(VN_FILE, 'utf-8')) : [];
      console.log(`\n📂 EN: ${enData.length} | VN: ${vnData.length}`);
      writeNewItemsFile(enData, vnData);

      const t0 = Date.now();
      const vnStats = await processLanguage(enData, vnData, 'vi',    VN_FILE, 'Tiếng Việt');
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n✅ Hoàn thành trong ${sec}s`);
      console.log(`   VN: ${vnStats.translated} dịch, ${vnStats.unchanged} giữ nguyên`);
    } catch (e) {
      console.error('❌ Lỗi:', e.message);
    }
  };

  await run();

  fs.watch(EN_FILE, { persistent: true }, async (eventType) => {
    if (eventType === 'change') {
      console.log('\n🔄 Phát hiện thay đổi ItemsData_en.json, chờ 2s...');
      await sleep(2000);
      await run();
    }
  });
}

async function main() {
  const watch = process.argv.includes('--watch');
  const force = process.argv.includes('--force');

  if (watch) {
    await watchMode();
    return;
  }

  console.log('🚀 translate-data.js bắt đầu\n');

  if (!fs.existsSync(EN_FILE)) {
    console.error('❌ Không tìm thấy ItemsData_en.json'); process.exit(1);
  }

  const rawEnData = JSON.parse(fs.readFileSync(EN_FILE, 'utf-8'));
  const enData = rawEnData.filter(item => !isOB55Item(item));
  const hiddenCount = rawEnData.length - enData.length;
  if (hiddenCount > 0) console.log(`🙈 Đã tạm ẩn ${hiddenCount} vật phẩm thuộc OB55.`);

  const vnData = fs.existsSync(VN_FILE) ? JSON.parse(fs.readFileSync(VN_FILE, 'utf-8')) : [];
  console.log(`📂 EN: ${enData.length} | VN: ${vnData.length}`);
  writeNewItemsFile(enData, vnData);

  const t0 = Date.now();
  const vnStats = await processLanguage(enData, vnData, 'vi',    VN_FILE, 'Tiếng Việt', force);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅ Hoàn thành trong ${sec}s`);
  console.log(`   VN: ${vnStats.translated} dịch/sửa, ${vnStats.unchanged} giữ nguyên`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });