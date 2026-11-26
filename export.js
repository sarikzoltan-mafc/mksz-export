// Megnyitja az urls.txt oldalait egy fej nélküli böngészőben (ahogy egy látogató),
// és elmenti a megjelenő szöveget (out/<név>.txt), valamint az oldal által
// betöltött JSON-válaszokat (out/<név>.json).
const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const lines = fs.readFileSync('urls.txt', 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  fs.mkdirSync('out', { recursive: true });
  const browser = await chromium.launch();
  let failed = 0;
  for (const line of lines) {
    const [name, url] = line.split(/\s+/);
    const page = await browser.newPage({ locale: 'hu-HU' });
    const json = [];
    page.on('response', async r => {
      try {
        if ((r.headers()['content-type'] || '').includes('application/json')) {
          const body = await r.json();
          json.push({ url: r.url().split('?')[0], body });
        }
      } catch (e) { /* nem JSON vagy már lezárt válasz */ }
    });
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(5000);
      // A „Program és eredmények” dátumszűrőjét a teljes szezonra állítjuk (a felnőtt-típusú
      // versenyoldalak alapból csak az aktuális hét körüli meccseket mutatják).
      const now = new Date();
      const y = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
      const range = await page.evaluate(([start, end]) => {
        let el = document.querySelector('input.datepicker');
        while (el && !el.__vue__) el = el.parentElement;
        for (let v = el && el.__vue__; v; v = v.$parent) {
          if (v.$options.name === 'Program_eredmenyek_blokk') {
            v.startDate = start; v.endDate = end; return true;
          }
        }
        return false;
      }, [`${y}.06.01.`, `${y + 1}.07.31.`]);
      if (range) {
        try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch (e) {}
        await page.waitForTimeout(4000);
      }
      console.log(`${name}: teljes szezonra állított dátumszűrő: ${range ? 'igen' : 'nem (nincs ilyen szűrő)'}`);
      // A lenyitható részek (pl. fordulók) kinyitása, ha vannak
      for (const b of await page.$$('button[aria-expanded="false"]')) {
        try { await b.click({ timeout: 1000 }); } catch (e) {}
      }
      await page.waitForTimeout(2000);
      const text = await page.innerText('body');
      const stamp = new Date().toISOString();
      fs.writeFileSync(`out/${name}.txt`, `# Forrás: ${url}\n# Mentve: ${stamp}\n\n${text}\n`);
      fs.writeFileSync(`out/${name}.json`, JSON.stringify({ source: url, saved: stamp, responses: json }, null, 1));
      console.log(`${name}: ${text.length} karakter szöveg, ${json.length} JSON-válasz`);
    } catch (e) {
      failed++;
      console.error(`${name}: HIBA – ${e.message.split('\n')[0]}`);
    }
    await page.close();
  }
  await browser.close();
  if (failed === lines.length) process.exit(1);
})();
