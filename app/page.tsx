import { ArrowUpRight, ShieldCheck, Layers3 } from 'lucide-react';

export default function Home() {
  return <main className="login-layout">
    <section className="login-story">
      <div className="wordmark"><Layers3 size={26} /> velocity<span> / campaign portal</span></div>
      <div><p className="eyebrow">YOUR GROWTH WORKSPACE</p><h1>Good campaigns.<br />Clear results.</h1><p className="story-copy">Your audience, campaigns, and performance.<br />One focused workspace for your brand.</p></div>
      <div className="brand-strip"><span>Kilele Rides</span><span>Karoo Coaches</span><span>Marrakech Express</span></div>
    </section>
    <section className="login-panel"><div className="login-card"><div className="icon-tile"><ArrowUpRight /></div><p className="eyebrow">WELCOME BACK</p><h2>Sign in to your workspace</h2><p className="muted">Use your approved brand account to continue.</p><form action="/login"><label>Email address<input name="email" type="email" placeholder="you@yourbrand.com" required autoComplete="username" /></label><label>Password<input name="password" type="password" placeholder="Enter your password" required autoComplete="current-password" /></label><button className="primary" type="submit">Continue <ArrowUpRight size={18}/></button></form><div className="divider">or</div><a className="secondary" href="/login">Continue with Google</a><p className="security-note"><ShieldCheck size={16}/> Access is limited to your brand’s team.</p></div></section>
  </main>;
}
