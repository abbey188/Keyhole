import { config } from "../lib/config";

/** Home page of a static build that has no release service or storage node behind it. It says so plainly and shows what can be checked. */
export function Showcase() {
  const link = (h: string) => `${location.pathname}${h}`;
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>What you can check here</h2>
      <p>This page is a static copy of the Keyhole web app on NEAR testnet. <strong>The interactive product (creating a safe, giving access, Ask, Claims) is not running here</strong>, because it needs the release service and the storage node, which are not hosted in this build.</p>
      <ul>
        <li><a href={link("#judge")} target="_blank" rel="noreferrer">The proof page</a>: every claim with its test or transaction, the attacks the contract refused, and a live check from the public testnet that the contract has no access keys.</li>
        <li><a href={link("#verify")} target="_blank" rel="noreferrer">The Verify page</a>: check a signed claim or an answer package in your browser, with no server.</li>
        {config.demoUrl && <li><a href={config.demoUrl} target="_blank" rel="noreferrer">The live demo</a>: the interactive app on testnet. It runs on a free trial and may be offline.</li>}
        {config.videoUrl && <li><a href={config.videoUrl} target="_blank" rel="noreferrer">The recorded demo</a>: the full story on testnet.</li>}
        {config.repoUrl && <li><a href={config.repoUrl} target="_blank" rel="noreferrer">The code</a>: run the whole product yourself with <code>./scripts/testnet-setup.sh</code> and <code>./scripts/dev-services.sh</code> (about five minutes).</li>}
      </ul>
      <p className="note">Testnet demo. No real money, and nothing here is audited: don't store real sensitive files.</p>
    </div>
  );
}
