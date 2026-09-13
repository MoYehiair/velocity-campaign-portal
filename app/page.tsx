import { Layers3 } from 'lucide-react';
import { LoginForm } from '@/components/login-form';

export default function Home() {
  return (
    <main className="login-layout">
      <section className="login-story">
        <div className="wordmark">
          <Layers3 size={26} /> velocity<span> / campaign portal</span>
        </div>
        <div>
          <p className="eyebrow">YOUR GROWTH WORKSPACE</p>
          <h1>
            Good campaigns.
            <br />
            Clear results.
          </h1>
          <p className="story-copy">
            Your audience, campaigns, and performance.
            <br />
            One focused workspace for your brand.
          </p>
        </div>
        <div className="brand-strip">
          <span>Kilele Rides</span>
          <span>Karoo Coaches</span>
          <span>Marrakech Express</span>
        </div>
      </section>
      <section className="login-panel">
        <LoginForm />
      </section>
    </main>
  );
}
