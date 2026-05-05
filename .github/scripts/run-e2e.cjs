const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // ✅ 已修正为 GitHub Pages 真实地址
  await page.goto('https://jack-ja-ck.github.io/--app/');

  const title = await page.title();
  console.log('页面标题:', title);

  if (!title.includes('敬拜') && !title.includes('投屏')) {
    console.error('❌ 标题不符合预期，可能页面未正确加载');
    process.exit(1);
  }

  await page.screenshot({ path: 'screenshot.png', fullPage: true });
  console.log('✅ 测试通过，截图已保存');

  await browser.close();
})();
