const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // 这里请替换成你的实际投屏页面地址
  // 如果 Vercel 地址不确定，先写成部署后的主页
  await page.goto('https://app-seven-phi-yp6z2gs.vercel.app');

  // 示例测试：检查页面标题是否包含“敬拜”或关键文字
  const title = await page.title();
  console.log('页面标题:', title);

  if (!title.includes('敬拜') && !title.includes('投屏')) {
    console.error('❌ 标题不符合预期，可能页面未正确加载');
    process.exit(1);
  }

  // 截图保存（Actions 运行后可以下载查看）
  await page.screenshot({ path: 'screenshot.png', fullPage: true });
  console.log('✅ 测试通过，截图已保存');

  await browser.close();
})();
