import styles from "./LoginLanding.module.css";

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={diagonal ? "M6 18 18 6M6 6h12v12" : "M5 12h14m-6-6 6 6-6 6"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function LoginLanding() {
  return (
    <main className={styles.landing}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brand} aria-label="随心一码">
            <span className={styles.brandMark} aria-hidden="true">{'{*}'}</span>
            <span>随心一码<span className={styles.brandDot}>.</span></span>
          </div>
          <nav className={styles.nav} aria-label="首页导航">
            <a className={styles.aboutLink} href="#how-it-works">怎么玩</a>
            <a className={styles.navLogin} href="/auth/login">登录 / 开始创作 <Arrow diagonal /></a>
          </nav>
        </header>

        <section className={styles.hero} aria-labelledby="landing-title">
          <div className={styles.heroCopy}>
            <div className={styles.eyebrow}><span /> Token 永久免费 · 和 AI 一起编程创作</div>
            <h1 id="landing-title" className={styles.title}>
              今朝侬<br />
              <span className={styles.vibe}>vibe<svg viewBox="0 0 300 18" preserveAspectRatio="none" aria-hidden="true"><path d="M3 13C68 1 186 2 295 8M24 16C113 7 224 7 280 12" /></svg></span> 了伐<span className={styles.question}>？</span>
            </h1>
            <p className={styles.subtitle}><strong>免费使用，</strong>随心创造。</p>
            <p className={styles.description}>平台 Token 永久免费，和 AI 聊天编程。<br className={styles.desktopBreak} />把你的想法和创意，变成真正能用的网页、工具和应用。</p>
            <div className={styles.heroActions}>
              <a className={styles.primaryButton} href="/auth/login">免费登录，开始创造 <Arrow /></a>
              <span className={styles.loginHint}>无需安装 · 不必先会代码 · 聊天就能开始</span>
            </div>
            <div className={styles.rewardTeaser}>
              <span className={styles.playIcon} aria-hidden="true">▶</span>
              <span>Token 永久免费 <span className={styles.smallArrow}>·</span> 广告支持运营</span>
              <span className={styles.policyBadge}>专注你的创意</span>
            </div>
          </div>

          <div className={styles.heroVisual} aria-label="用自然语言创建应用的产品示意">
            <div className={styles.visualHeading}>
              <div className={styles.freeSticker}>用灵感开场<span>不必先会写代码</span></div>
              <div className={styles.orbitLabel} aria-hidden="true">Less overthinking.<br /><strong>More creating.</strong></div>
            </div>
            <div className={styles.productWindow}>
              <div className={styles.windowBar}>
                <div className={styles.windowDots} aria-hidden="true"><i /><i /><i /></div>
                <span>我的第一个创意 / 随心一码</span>
                <span className={styles.demoLabel}>体验示意</span>
              </div>
              <div className={styles.productBody}>
                <div className={styles.promptBubble}>帮我做一个，<br /><strong>记录生活小美好的网页。</strong><span>↵</span></div>
                <div className={styles.agentReply}><span className={styles.miniMark} aria-hidden="true">✳</span><div>好想法。我们把它变成真的。<div className={styles.codeLines} aria-hidden="true"><span /><span /><span /></div></div></div>
                <div className={styles.previewCard}>
                  <div className={styles.previewNav}><span>小美好<span>®</span></span><span>生活值得被记录 ↗</span></div>
                  <div className={styles.previewContent}>
                    <span className={styles.previewTag}>收藏生活里的每一份美好</span>
                    <p>把普通日子，<br /><span>过成小小收藏。</span></p>
                    <div className={styles.previewChips}><span>☀ 一点阳光</span><span>♫ 一首好歌</span><span>♡ 一件小事</span></div>
                  </div>
                  <div className={styles.previewFlower} aria-hidden="true">✳</div>
                </div>
                <div className={styles.productFooter}><span><i /> 从一句话，到一个作品</span><span>你的想法，正在发生 ↗</span></div>
              </div>
            </div>
            <div className={styles.ideaSticker} aria-hidden="true"><span>你好，</span><strong>我的新作品！</strong><svg viewBox="0 0 70 40"><path d="M5 6c6 25 40 32 58 10m-14-2 15 1-1 15" /></svg></div>
          </div>
        </section>

        <section id="how-it-works" className={styles.howItWorks} aria-labelledby="how-title">
          <div className={styles.sectionIntro}><span className={styles.sectionLabel}>你的想法，就是下一个作品。</span><h2 id="how-title">别等准备好，<br />先把第一步写出来。</h2></div>
          <ol className={styles.steps}>
            <li><span className={styles.stepNumber}>01 /</span><h3>免费登录，带上创意</h3><p>网站免费使用，不必先会编程。<br />有一句「我想做一个……」就能开始。</p></li>
            <li><span className={styles.stepNumber}>02 /</span><h3>和 AI 聊天，实现想法</h3><p>用自己的话描述需求，边聊边改。<br />一起做出你的网页、工具和应用。</p></li>
            <li><span className={styles.stepNumber}>03 /</span><h3>Token 永久免费</h3><p>平台不售卖 Token，仅通过广告支持运营。<br />让你的每一个创意，都能免费开始。</p></li>
          </ol>
        </section>

        <footer className={styles.footer}>
          <span><strong>随心一码.</strong> 给每个「我有个想法」一个开始。</span>
          <span className={styles.footerNote}>平台 Token 永久免费，仅通过广告支持运营。</span>
          <a href="/auth/login">现在就 vibe 一下 <Arrow diagonal /></a>
        </footer>
      </div>
    </main>
  );
}
