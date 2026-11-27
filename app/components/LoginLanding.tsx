"use client";

import styles from "./LoginLanding.module.css";
import LanguageSwitcher from "./LanguageSwitcher";
import { useMessages } from "@/app/lib/i18n/context";

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={diagonal ? "M6 18 18 6M6 6h12v12" : "M5 12h14m-6-6 6 6-6 6"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function LoginLanding({ groupUrl = null }: { groupUrl?: string | null }) {
  const m = useMessages();
  const L = m.loginLanding;

  // The landing page scrolls inside `.landing` (body is overflow-hidden), so
  // the browser's default fragment scrolling does not reach these sections.
  // Scroll the container explicitly and keep the URL hash in sync.
  const scrollToId = (id: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const target = document.getElementById(id);
    const container = event.currentTarget.closest(`.${styles.landing}`);
    if (container instanceof HTMLElement && target) {
      const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo({ top, behavior: "smooth" });
    } else {
      target?.scrollIntoView({ behavior: "smooth" });
    }
    window.history.replaceState(null, "", `#${id}`);
  };

  return (
    <main className={styles.landing}>
      <div className={styles.shell}>
        <header className={styles.header} id="top">
          <a className={styles.brand} aria-label={m.common.brandName} href="#top" onClick={scrollToId("top")}>
            <span className={styles.brandMark} aria-hidden="true">{'</>'}</span>
            <span>{m.common.brandName}<span className={styles.brandDot}>.</span></span>
          </a>
          <div className="flex items-center gap-3">
            <nav className={styles.nav} aria-label={L.homeNav}>
              <a className={styles.aboutLink} href="#how-it-works" onClick={scrollToId("how-it-works")}>{L.howItWorks}</a>
              <a className={styles.aboutLink} href="#plans" onClick={scrollToId("plans")}>{L.plans}</a>
              <a className={styles.navLogin} href="/auth/login">{L.loginCta} <Arrow diagonal /></a>
            </nav>
            <LanguageSwitcher />
          </div>
        </header>

        <section className={styles.hero} aria-labelledby="landing-title">
          <div className={styles.heroCopy}>
            <div className={styles.eyebrow}><span /> {L.eyebrow}</div>
            <h1 id="landing-title" className={styles.title}>
              {L.titleToday}<br />
              <span className={styles.vibe}>vibe<svg viewBox="0 0 300 18" preserveAspectRatio="none" aria-hidden="true"><path d="M3 13C68 1 186 2 295 8M24 16C113 7 224 7 280 12" /></svg></span> {L.titleVibed}<span className={styles.question}>{L.titleQuestion}</span>
            </h1>
            <p className={styles.subtitle}><strong>{L.subtitleFree}</strong>{L.subtitleCreate}</p>
            <p className={styles.description}>{L.description}</p>
            <div className={styles.heroActions}>
              <a className={styles.primaryButton} href="/auth/login">{L.primaryCta} <Arrow /></a>
              <span className={styles.loginHint}>{L.loginHint}</span>
            </div>
            <div className={styles.rewardTeaser}>
              <span className={styles.playIcon} aria-hidden="true">▶</span>
              <span>{L.rewardTeaser}</span>
              <span className={styles.policyBadge}>{L.policyBadge}</span>
            </div>
          </div>

          <div className={styles.heroVisual} aria-label={L.visualAriaLabel}>
            <div className={styles.visualHeading}>
              <div className={styles.freeSticker}>{L.freeSticker}<span>{L.freeStickerSub}</span></div>
              <div className={styles.orbitLabel} aria-hidden="true">Less overthinking.<br /><strong>More creating.</strong></div>
            </div>
            <div className={styles.productWindow}>
              <div className={styles.windowBar}>
                <div className={styles.windowDots} aria-hidden="true"><i /><i /><i /></div>
                <span>{L.windowTitle}</span>
                <span className={styles.demoLabel}>{L.demoLabel}</span>
              </div>
              <div className={styles.productBody}>
                <div className={styles.promptBubble}>{L.promptBubble}<span>↵</span></div>
                <div className={styles.agentReply}><span className={styles.miniMark} aria-hidden="true">✳</span><div>{L.agentReply}<div className={styles.codeLines} aria-hidden="true"><span /><span /><span /></div></div></div>
                <div className={styles.previewCard}>
                  <div className={styles.previewNav}><span>{L.previewNavBrand}<span>®</span></span><span>{L.previewNavSlogan}</span></div>
                  <div className={styles.previewContent}>
                    <span className={styles.previewTag}>{L.previewTag}</span>
                    <p>{L.previewLine1}<br /><span>{L.previewLine2}</span></p>
                    <div className={styles.previewChips}><span>{L.chip1}</span><span>{L.chip2}</span><span>{L.chip3}</span></div>
                  </div>
                  <div className={styles.previewFlower} aria-hidden="true">✳</div>
                </div>
                <div className={styles.productFooter}><span><i /> {L.productFooterLeft}</span><span>{L.productFooterRight}</span></div>
              </div>
            </div>
            <div className={styles.ideaSticker} aria-hidden="true"><span>{L.ideaStickerHello}</span><strong>{L.ideaStickerWork}</strong><svg viewBox="0 0 70 40"><path d="M5 6c6 25 40 32 58 10m-14-2 15 1-1 15" /></svg></div>
          </div>
        </section>

        <section id="how-it-works" className={styles.howItWorks} aria-labelledby="how-title">
          <div className={styles.sectionIntro}><span className={styles.sectionLabel}>{L.howSectionLabel}</span><h2 id="how-title">{L.howTitleLine1}<br />{L.howTitleLine2}</h2></div>
          <ol className={styles.steps}>
            <li><span className={styles.stepNumber}>01 /</span><h3>{L.step1Title}</h3><p>{L.step1Body}</p></li>
            <li><span className={styles.stepNumber}>02 /</span><h3>{L.step2Title}</h3><p>{L.step2Body}</p></li>
            <li><span className={styles.stepNumber}>03 /</span><h3>{L.step3Title}</h3><p>{L.step3Body}</p></li>
          </ol>
        </section>

        <section id="plans" className={styles.plans} aria-labelledby="plans-title">
          <div className={styles.plansIntro}>
            <div>
              <span className={styles.sectionLabel}>{L.plansSectionLabel}</span>
              <h2 id="plans-title">{L.plansTitle}<span>.</span></h2>
            </div>
            <p>{L.plansIntro}</p>
          </div>
          <div className={styles.plansTableWrap} role="region" aria-label={L.plansTableAria} tabIndex={0}>
            <table className={styles.plansTable}>
              <caption className={styles.srOnly}>{L.plansTableCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{L.thPlan}</th>
                  <th scope="col"><span className={styles.planBadge}>{L.personalBadge}</span><strong>{L.freePlan}</strong></th>
                  <th scope="col"><span className={styles.businessBadge}>{L.businessBadge}</span><strong>{L.businessPlan}</strong></th>
                </tr>
              </thead>
              <tbody>
                <tr><th scope="row">{L.rowAudience}</th><td>{L.rowAudienceFree}</td><td>{L.rowAudienceBiz}</td></tr>
                <tr><th scope="row">{L.rowUsage}</th><td>{L.rowUsageFree}</td><td>{L.rowUsageBiz}</td></tr>
                <tr><th scope="row">{L.rowDeploy}</th><td>{L.rowDeployFree}</td><td>{L.rowDeployBiz}</td></tr>
                <tr><th scope="row">{L.rowDuration}</th><td>{L.rowDurationFree}</td><td>{L.rowDurationBiz}</td></tr>
                <tr><th scope="row">{L.rowFiling}</th><td>—</td><td>{L.rowFilingBiz}</td></tr>
                <tr>
                  <th scope="row">{L.rowStart}</th>
                  <td><a className={styles.planLink} href="/auth/login">{L.startFree} <span aria-hidden="true">↗</span></a></td>
                  <td>
                    <div className={styles.contactDetails}>
                      <span>{L.qqGroupLabel}</span>
                      <span>{L.wechatLabel}</span>
                      {groupUrl && <a className={styles.qqLink} href={groupUrl} target="_blank" rel="noopener noreferrer">{L.joinQq} <span aria-hidden="true">↗</span></a>}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <footer className={styles.footer}>
          <span><strong>{m.common.brandName}.</strong> {L.footerTagline}</span>
          <span className={styles.footerNote}>{L.footerNote}</span>
          <a href="/auth/login">{L.footerCta} <Arrow diagonal /></a>
        </footer>
      </div>
    </main>
  );
}
