// A MAFC Eredményfigyelő forrásoldalainak mentése (kosárlabda, röplabda, vízilabda).
// (Jelenleg: hunvolley.info napi műsor és a DataProject röplabdaoldalak.)
// Egy fej nélküli böngészővel, egyenként (a szövetségi oldalak korlátozzák a párhuzamos
// lekérést) megnyitja a napi műsoroldalakat, és a web/ mappába menti:
//   web/<forrás>/<kulcs>.html  – az oldal megjelenített HTML-je (linkekkel együtt)
//   web/<forrás>/<kulcs>.txt   – az oldal látható szövege
//   web/mafc.json              – minden oldalról a "MAFC"-ot tartalmazó sorok/blokkok és linkjeik
//   web/index.json             – a mentett oldalak listája, állapottal (ok / hiba)
// A mentés a "web-export" ágra kerül (mindig egyetlen commit, így a tároló nem hízik).
const fs = require('fs');
const { chromium } = require('playwright');

const TZ = 'Europe/Budapest';
function budapestDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => budapestDate(from + i));

const SITES = {
  hunvolley: d => `https://www.hunvolley.info/pr_a/010/200/p_200.asp?p_datum=${d}`,
};
const targets = [];
const add = (site, key, url) => { if (!targets.some(t => t.site === site && t.key === key)) targets.push({ site, key, url }); };
// Az mkosz.hu (HTTP 503) és a waterpolo.hu (kapcsolatbontás) nem szolgálja ki a GitHub
// szervereit, ezért ezeket itt nem mentjük; azokat a frissítés továbbra is közvetlenül olvassa.
for (const d of range(-1, 7)) add('hunvolley', d, SITES.hunvolley(d));
add('dataproject', 'nb1-liga', 'https://hvf-web.dataproject.com/CompetitionMatches.aspx?ID=65&PID=72');
add('dataproject', 'magyar-kupa', 'https://hvf-web.dataproject.com/CompetitionMatches.aspx?ID=66&PID=78');
add('dataproject', 'u20-fiu', 'https://hvf-web.dataproject.com/CompetitionMatches.aspx?ID=67&PID=76');
// Pótlólagos napok (pl. egy régebbi, még eredmény nélküli meccs napja):
// web-extra.txt soronként "<forrás> ÉÉÉÉ-HH-NN" (forrás: hunvolley),
// vagy a kézi indításnál az EXTRA környezeti változóban szóközzel elválasztva "forrás:dátum".
const extra = [];
if (fs.existsSync('web-extra.txt')) {
  for (const l of fs.readFileSync('web-extra.txt', 'utf8').split('\n')) {
    const m = l.trim().match(/^(hunvolley)\s+(\d{4}-\d{2}-\d{2})$/);
    if (m) extra.push([m[1], m[2]]);
  }
}
for (const tok of (process.env.EXTRA || '').split(/\s+/)) {
  const m = tok.match(/^(hunvolley):(\d{4}-\d{2}-\d{2})$/);
  if (m) extra.push([m[1], m[2]]);
}
for (const [s, d] of extra) add(s, d, SITES[s](d));

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.rmSync('web', { recursive: true, force: true });
  fs.mkdirSync('web', { recursive: true });
  const t0 = Date.now();
  const browser = await chromium.launch();
  const index = [], mafc = [];
  for (const t of targets) {
    if (Date.now() - t0 > 25 * 60000) { index.push({ site: t.site, key: t.key, url: t.url, ok: false, error: 'kihagyva (időkorlát)' }); continue; }
    fs.mkdirSync(`web/${t.site}`, { recursive: true });
    let rec = { site: t.site, key: t.key, url: t.url, ok: false };
    for (let attempt = 1; attempt <= 2 && !rec.ok; attempt++) {
      const page = await browser.newPage({ locale: 'hu-HU', timezoneId: 'Europe/Budapest' });
      try {
        const resp = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try { await page.waitForLoadState('load', { timeout: 20000 }); } catch (e) {}
        await page.waitForTimeout(t.site === 'dataproject' ? 6000 : 2500);
        const status = resp ? resp.status() : 0;
        const text = await page.innerText('body');
        if (status === 429 || /RATE_LIMIT|Too Many Requests/i.test(text.slice(0, 2000))) {
          throw new Error(`korlátozás (HTTP ${status})`);
        }
        if (status >= 400) throw new Error(`HTTP ${status}`);
        const html = await page.content();
        console.log(`  ${t.site}/${t.key}: HTTP ${status}, ${((Date.now() - t0) / 1000).toFixed(0)} mp`);
        // A "MAFC"-ot tartalmazó táblázatsorok, illetve a linkek legkisebb MAFC-os környezete
        const hits = await page.evaluate(() => {
          const out = [], seen = new Set();
          const push = el => {
            const text = el.innerText.replace(/\s+\n/g, '\n').trim();
            if (!/MAFC/.test(text) || seen.has(text)) return;
            seen.add(text);
            out.push({ text, links: [...el.querySelectorAll('a[href]')].map(a => ({ text: a.innerText.trim(), href: a.href })) });
          };
          document.querySelectorAll('tr').forEach(tr => { if (!tr.querySelector('tr')) push(tr); });
          document.querySelectorAll('a[href]').forEach(a => {
            if (a.closest('tr')) return;
            let best = null;
            for (let el = a; el && el !== document.body; el = el.parentElement) {
              if (el.innerText.length > 600) break;
              if (/MAFC/.test(el.innerText)) { best = el; break; }
            }
            if (best) push(best);
          });
          return out;
        });
        const stamp = new Date().toISOString();
        fs.writeFileSync(`web/${t.site}/${t.key}.html`, html);
        fs.writeFileSync(`web/${t.site}/${t.key}.txt`, `# Forrás: ${t.url}\n# Mentve: ${stamp}\n\n${text}\n`);
        rec = { ...rec, ok: true, status, saved: stamp, textChars: text.length, mafcHits: hits.length };
        mafc.push({ site: t.site, key: t.key, url: t.url, hits });
        console.log(`${t.site}/${t.key}: ${text.length} karakter, ${hits.length} MAFC-találat`);
      } catch (e) {
        rec.error = e.message.split('\n')[0];
        console.error(`${t.site}/${t.key}: HIBA (${attempt}. próba) – ${rec.error}`);
        await sleep(8000);
      }
      await page.close();
    }
    index.push(rec);
    fs.writeFileSync('web/index.json', JSON.stringify({ saved: new Date().toISOString(), partial: true, pages: index }, null, 1));
    await sleep(3000);
  }
  await browser.close();
  const saved = new Date().toISOString();
  fs.writeFileSync('web/index.json', JSON.stringify({ saved, pages: index }, null, 1));
  fs.writeFileSync('web/mafc.json', JSON.stringify({ saved, pages: mafc }, null, 1));
  const bad = index.filter(r => !r.ok).length;
  console.log(`Kész: ${index.length - bad}/${index.length} oldal mentve.`);
  if (bad === index.length) process.exit(1);
})();
