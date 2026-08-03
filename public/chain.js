// Real-stakes ("skin in the game") — opt-in, loaded ONLY when the server's
// ONCHAIN_ENABLED flag is on (see initChainLayer() in feed.html: it fetches
// /api/chain/status first and injects this file's <script> tag only when the
// response says enabled). This file existing in a page load already means the
// flag is on; there is no further flag check inside it, and nothing in here
// runs unless feed.html decided to load it.
//
// Architecture: the server ASSEMBLES take_position/claim_winnings
// transactions (see the /api/chain/* routes in server.ts) but never signs or
// holds a user's funds — the user's own wallet (Phantom) signs and broadcasts
// client-side. This file only talks to window.solana (Phantom's injected
// provider) and this app's own same-origin /api/chain/* routes. The one piece
// of real client-side Solana code it needs — deserializing the server-built
// transaction bytes so Phantom can sign them — is loaded from a CDN lazily, on
// first actual stake attempt, not merely when this file loads: seeing the
// "make it real" button costs nothing extra.
(function () {
  const CLUSTER_LABEL = "Solana devnet";
  let web3 = null; // @solana/web3.js, lazy-loaded on first real use
  let wallet = null; // {publicKey: string} once connected, shared across sheets in this session

  async function loadWeb3() {
    if (web3) return web3;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/@solana/web3.js@1.95.3/lib/index.iife.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Couldn't load the Solana library — check your connection and try again."));
      document.head.appendChild(s);
    });
    web3 = window.solanaWeb3;
    return web3;
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function connectWallet() {
    const provider = window.solana;
    if (!provider || !provider.isPhantom) {
      throw new Error("No Solana wallet found — install Phantom to put real stake behind a call.");
    }
    const resp = await provider.connect();
    wallet = { publicKey: resp.publicKey.toString() };
    return wallet;
  }

  function short(s) {
    return s.length > 10 ? s.slice(0, 4) + "…" + s.slice(-4) : s;
  }

  // Mirrors markets.ts's poolPct exactly (same clamp, same rounding) — this
  // is the REAL-MONEY pool's own odds, computed from on-chain lamports
  // (Market.total_yes/total_no), entirely separate from the play-token pool
  // the card's own YES/NO buttons already show live (see updateCardOdds in
  // feed.html). Two pools, two numbers, on purpose: a user can be "70% on
  // YES" in predictions and "30% on YES" in real SOL on the very same
  // market, because they are different people making different bets.
  function poolPct(chosen, opposite) {
    const total = chosen + opposite;
    if (total <= 0) return null;
    return Math.max(1, Math.min(99, Math.round((chosen / total) * 100)));
  }
  function fmtMult(pct) { return (100 / pct).toFixed(1) + "×"; }

  function sheetShell() {
    const dim = document.createElement("div");
    dim.className = "cdim chaindim";
    dim.innerHTML = `<div class="csheet chainsheet" role="dialog" aria-label="Make it real"></div>`;
    dim.onclick = (e) => { if (e.target === dim) dim.remove(); };
    document.body.appendChild(dim);
    return dim.querySelector(".chainsheet");
  }

  /**
   * The claim flow — the collect half of the real-money layer.
   *
   * Deliberately walks the user through the only three states that exist after
   * a market resolves, and never guesses between them: we cannot know whether
   * someone has a position until their wallet is connected, so the first step
   * is always "connect to check" rather than a claim button that might do
   * nothing. Losing and already-claimed are stated plainly instead of being
   * hidden — a dead end the user understands beats a button that errors.
   */
  async function renderClaim(body, slug, marketState) {
    const won = (marketState.winningSide || "").toUpperCase();
    const shell = (inner) => {
      body.innerHTML = `<h3>Market resolved ${won}</h3>${inner}`;
      const c = body.querySelector(".cclose");
      if (c) c.onclick = () => body.closest(".cdim").remove();
    };

    if (!wallet) {
      shell(`<p class="cnote">This market settled <b>${won}</b> on ${CLUSTER_LABEL}. If you had real SOL on it, connect the wallet you staked with to collect.</p>
        <button class="cbtn" id="chainconnect">Connect wallet to check</button>
        <button class="cclose">Not now</button>`);
      body.querySelector("#chainconnect").onclick = async () => {
        const b = body.querySelector("#chainconnect");
        b.disabled = true; b.textContent = "Connecting…";
        try { await connectWallet(); await renderClaim(body, slug, marketState); }
        catch (e) {
          b.disabled = false; b.textContent = "Connect wallet to check";
          let err = body.querySelector(".chain-err");
          if (!err) { err = document.createElement("p"); err.className = "chain-err"; b.after(err); }
          err.textContent = e.message;
        }
      };
      return;
    }

    shell(`<p class="cnote">Checking your position…</p>`);
    let position = null, reachable = true;
    try {
      const r = await fetch(`/api/chain/position?slug=${encodeURIComponent(slug)}&userPubkey=${encodeURIComponent(wallet.publicKey)}`);
      const j = await r.json();
      if (!j.ok) reachable = false; else position = j.position;
    } catch (e) { reachable = false; }

    if (!reachable) {
      shell(`<p class="cnote">Couldn't read your position from ${CLUSTER_LABEL} just now. Your funds are unaffected — try again in a moment.</p>
        <button class="cclose">Close</button>`);
      return;
    }
    if (!position) {
      shell(`<p class="cnote">This wallet didn't have real SOL on this market. Nothing to collect.</p>
        <button class="cclose">Close</button>`);
      return;
    }
    if (position.claimed) {
      shell(`<p class="cnote">Already collected — these winnings are in your wallet.</p>
        <button class="cclose">Close</button>`);
      return;
    }
    if ((position.side || "").toUpperCase() !== won) {
      shell(`<p class="cnote">You were on <b>${(position.side || "").toUpperCase()}</b> and it resolved <b>${won}</b>. Nothing to collect on this one.</p>
        <button class="cclose">Close</button>`);
      return;
    }

    const sol = (position.lamports / 1e9).toFixed(3);
    shell(`<p class="cnote">You called <b>${won}</b> with <b>${sol} SOL</b> — and you were right. Collect your winnings; your wallet signs, we never hold them.</p>
      <button class="claimbtn" id="chainclaim">Claim winnings</button>
      <div class="chain-line" id="chainline"></div>
      <button class="cclose">Later</button>`);

    const btn = body.querySelector("#chainclaim"), line = body.querySelector("#chainline");
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = "Preparing…";
      try {
        const prep = await fetch("/api/chain/claim/prepare", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug, userPubkey: wallet.publicKey }),
        });
        const pj = await prep.json();
        if (!prep.ok || !pj.ok) throw new Error(pj.error || pj.reason || "Couldn't prepare the claim.");
        const w3 = await loadWeb3();
        const tx = w3.Transaction.from(b64ToBytes(pj.txBase64));
        btn.textContent = "Confirm in wallet…";
        const { signature } = await window.solana.signAndSendTransaction(tx);
        body.innerHTML = `<h3>Collected ✓</h3>
          <p class="cnote">Your winnings are on their way to your wallet, on ${CLUSTER_LABEL}.</p>
          <p class="chain-sig">tx: <a href="https://explorer.solana.com/tx/${signature}?cluster=devnet" target="_blank" rel="noopener">${short(signature)} ↗</a></p>
          <button class="cclose">Done</button>`;
        body.querySelector(".cclose").onclick = () => body.closest(".cdim").remove();
      } catch (e) {
        btn.disabled = false; btn.textContent = "Claim winnings";
        if (line) line.textContent = e.message || "Something went wrong — try again.";
      }
    };
  }

  async function openStakeSheet(slug) {
    const body = sheetShell();
    body.innerHTML = `<h3>Make it real</h3><p class="cnote">Checking this market…</p>`;

    let marketState;
    try {
      const r = await fetch(`/api/chain/market/${encodeURIComponent(slug)}`);
      marketState = await r.json();
    } catch (e) {
      marketState = { ok: false, reason: "unreachable" };
    }
    if (!marketState.ok) {
      body.innerHTML = `<h3>Make it real</h3>
        <p class="cnote">This market isn't available for real stakes right now (${esc(marketState.reason || "unknown")}).</p>
        <button class="cclose">Close</button>`;
      body.querySelector(".cclose").onclick = () => body.closest(".cdim").remove();
      return;
    }
    // Resolved -> this sheet stops being a place to stake and becomes the place
    // to COLLECT. Until this existed, a winning on-chain position had no
    // in-product path to claim_winnings at all: the contract instruction and
    // the server's prepare route were both there, but nothing in the UI ever
    // called them, so a winner's SOL simply sat in the vault. Same
    // non-custodial contract as staking — the server assembles, the user's own
    // wallet signs and broadcasts, the admin key is never involved.
    if (marketState.resolved) {
      await renderClaim(body, slug, marketState);
      return;
    }

    // The real-money pool's own odds — live from Solana, not derived from the
    // free predictions pool the card behind this sheet already shows. Shown
    // even before a wallet connects, so there's something to decide from.
    const yesLamports = marketState.totalYesLamports ?? 0, noLamports = marketState.totalNoLamports ?? 0;
    const yesOnchainPct = poolPct(yesLamports, noLamports), noOnchainPct = yesOnchainPct == null ? null : 100 - yesOnchainPct;
    const onchainOddsHTML = yesOnchainPct == null
      ? `<p class="chain-pool-empty">No real stake on this market yet — first in sets the line.</p>`
      : `<div class="chain-pool-odds">
           <span class="chain-pool-side">YES <b>${yesOnchainPct}%</b> <small>${fmtMult(yesOnchainPct)}</small></span>
           <span class="chain-pool-side">NO <b>${noOnchainPct}%</b> <small>${fmtMult(noOnchainPct)}</small></span>
         </div>`;

    // Proposed creator + protocol fee rates — disclosed even though neither is
    // actually deducted yet (the on-chain program has no fee instruction; see
    // economy.ts). Saying so plainly beats staying silent about a rate we
    // intend to charge once the program supports it.
    const feeNoteHTML = (marketState.realCreatorFeeBps || marketState.realProtocolFeeBps)
      ? `<p class="chain-fee-note">Proposed fees: creator ${((marketState.realCreatorFeeBps||0)/100).toFixed(0)}% · platform ${((marketState.realProtocolFeeBps||0)/100).toFixed(0)}% — not yet deducted on-chain.</p>`
      : "";

    const render = () => {
      body.innerHTML = `
        <h3>Make it real</h3>
        <p class="cnote">Optional. Real SOL on ${CLUSTER_LABEL}, separate from your free predictions above — this never affects them, and it's never required to play.</p>
        ${onchainOddsHTML}
        ${feeNoteHTML}
        ${wallet ? `<p class="chain-wallet">Wallet: <b>${short(wallet.publicKey)}</b></p>`
          : `<button class="cbtn" id="chainconnect">Connect wallet</button>`}
        ${wallet ? `
        <div class="chain-side-row">
          <button class="chain-side" data-side="yes" type="button">YES</button>
          <button class="chain-side" data-side="no" type="button">NO</button>
        </div>
        <input class="chain-amt" type="number" min="0.001" step="0.001" placeholder="SOL amount" inputmode="decimal">
        <div class="chain-line" id="chainline"></div>
        <button class="claimbtn" id="chainstake" disabled>Put SOL on it</button>
        ` : ""}
        <button class="cclose">Not now</button>`;
      body.querySelector(".cclose").onclick = () => body.closest(".cdim").remove();

      const connectBtn = body.querySelector("#chainconnect");
      if (connectBtn) connectBtn.onclick = async () => {
        connectBtn.disabled = true; connectBtn.textContent = "Connecting…";
        try { await connectWallet(); render(); }
        catch (e) {
          connectBtn.disabled = false; connectBtn.textContent = "Connect wallet";
          let err = body.querySelector(".chain-err");
          if (!err) { err = document.createElement("p"); err.className = "chain-err"; connectBtn.after(err); }
          err.textContent = e.message;
        }
      };

      let side = null;
      const sideBtns = [...body.querySelectorAll(".chain-side")];
      const amtInput = body.querySelector(".chain-amt");
      const stakeBtn = body.querySelector("#chainstake");
      const line = body.querySelector("#chainline");
      const refresh = () => {
        const amt = parseFloat(amtInput ? amtInput.value : "");
        if (stakeBtn) stakeBtn.disabled = !side || !(amt > 0);
        if (line) line.textContent = side && amt > 0
          ? `Staking ${amt} SOL on ${side.toUpperCase()}. Your wallet will ask you to confirm.` : "";
      };
      sideBtns.forEach((b) => b.onclick = () => {
        side = b.dataset.side;
        sideBtns.forEach((x) => x.classList.toggle("on", x === b));
        refresh();
      });
      if (amtInput) amtInput.oninput = refresh;
      if (stakeBtn) stakeBtn.onclick = async () => {
        stakeBtn.disabled = true; stakeBtn.textContent = "Preparing…";
        try {
          const lamports = Math.round(parseFloat(amtInput.value) * 1e9);
          const prep = await fetch("/api/chain/position/prepare", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ slug, userPubkey: wallet.publicKey, side, lamports }),
          });
          const pj = await prep.json();
          if (prep.status === 451) throw new Error("Real-money stakes aren't available in your region.");
          if (!prep.ok || !pj.ok) throw new Error(pj.error || "Couldn't prepare the transaction.");
          const w3 = await loadWeb3();
          const tx = w3.Transaction.from(b64ToBytes(pj.txBase64));
          stakeBtn.textContent = "Confirm in wallet…";
          const { signature } = await window.solana.signAndSendTransaction(tx);
          body.innerHTML = `<h3>Staked ✓</h3>
            <p class="cnote">${amtInput.value} SOL on ${side.toUpperCase()}, on ${CLUSTER_LABEL}.</p>
            <p class="chain-sig">tx: <a href="https://explorer.solana.com/tx/${signature}?cluster=devnet" target="_blank" rel="noopener">${short(signature)} ↗</a></p>
            <button class="cclose">Done</button>`;
          body.querySelector(".cclose").onclick = () => body.closest(".cdim").remove();
        } catch (e) {
          stakeBtn.disabled = false; stakeBtn.textContent = "Put SOL on it";
          if (line) line.textContent = e.message || "Something went wrong — try again.";
        }
      };
    };
    render();
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /** USDC on Solana — the mint venue orders are denominated in. */
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const USDC_DECIMALS = 6;

  /**
   * The venue stake sheet: real money on a POLYMARKET market, routed through
   * Jupiter's order API. Non-custodial on exactly the same terms as our own
   * parimutuel — the server asks Jupiter to build the transaction with the
   * USER's pubkey as owner, and the user's own wallet signs and broadcasts
   * it. No key of ours is involved and we never hold the funds.
   *
   * Deliberately states WHERE the market comes from. A user putting real
   * money down should know this one is Polymarket's book and not ours, and
   * that the creator fee they see on community cards does NOT apply here —
   * nobody tagged this market into existence, so there is no creator to pay.
   */
  async function openVenueSheet(marketId, card) {
    const body = sheetShell();
    const question = card?.querySelector(".take")?.textContent?.trim() || "this market";

    const render = () => {
      body.innerHTML = `
        <h3>Make it real</h3>
        <p class="cnote">Optional. Real USDC on <b>Polymarket</b>, routed via Jupiter — this is their market, not one someone tagged into Oddie, so there's no creator fee on it. Your free predictions are untouched either way.</p>
        <p class="chain-fee-note">${esc(question)}</p>
        ${wallet ? `<p class="chain-wallet">Wallet: <b>${short(wallet.publicKey)}</b></p>`
          : `<button class="cbtn" id="chainconnect">Connect wallet</button>`}
        ${wallet ? `
        <div class="chain-side-row">
          <button class="chain-side" data-side="yes" type="button">YES</button>
          <button class="chain-side" data-side="no" type="button">NO</button>
        </div>
        <input class="chain-amt" type="number" min="1" step="1" placeholder="USDC amount" inputmode="decimal">
        <div class="chain-line" id="chainline"></div>
        <button class="claimbtn" id="chainstake" disabled>Put USDC on it</button>
        ` : ""}
        <button class="cclose">Not now</button>`;
      body.querySelector(".cclose").onclick = () => body.closest(".cdim").remove();

      const connectBtn = body.querySelector("#chainconnect");
      if (connectBtn) connectBtn.onclick = async () => {
        connectBtn.disabled = true; connectBtn.textContent = "Connecting…";
        try { await connectWallet(); render(); }
        catch (e) {
          connectBtn.disabled = false; connectBtn.textContent = "Connect wallet";
          let err = body.querySelector(".chain-err");
          if (!err) { err = document.createElement("p"); err.className = "chain-err"; connectBtn.after(err); }
          err.textContent = e.message;
        }
      };

      let side = null;
      const sideBtns = [...body.querySelectorAll(".chain-side")];
      const amtInput = body.querySelector(".chain-amt");
      const stakeBtn = body.querySelector("#chainstake");
      const line = body.querySelector("#chainline");
      const refresh = () => {
        const amt = parseFloat(amtInput ? amtInput.value : "");
        if (stakeBtn) stakeBtn.disabled = !side || !(amt > 0);
        if (line) line.textContent = side && amt > 0
          ? `Buying ${side.toUpperCase()} with ${amt} USDC. Your wallet will ask you to confirm.` : "";
      };
      sideBtns.forEach((b) => b.onclick = () => {
        side = b.dataset.side;
        sideBtns.forEach((x) => x.classList.toggle("on", x === b));
        refresh();
      });
      if (amtInput) amtInput.oninput = refresh;
      if (stakeBtn) stakeBtn.onclick = async () => {
        stakeBtn.disabled = true; stakeBtn.textContent = "Preparing…";
        try {
          const depositAmount = Math.round(parseFloat(amtInput.value) * 10 ** USDC_DECIMALS);
          const prep = await fetch("/api/venue/order/prepare", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ marketId, userPubkey: wallet.publicKey, side, depositAmount, depositMint: USDC_MINT }),
          });
          const pj = await prep.json();
          if (prep.status === 451) throw new Error("Real money on Polymarket markets isn't available in your region.");
          if (!prep.ok || !pj.ok) throw new Error(pj.error || pj.reason || "Couldn't prepare the order.");
          const w3 = await loadWeb3();
          const tx = w3.Transaction.from(b64ToBytes(pj.txBase64));
          stakeBtn.textContent = "Confirm in wallet…";
          const { signature } = await window.solana.signAndSendTransaction(tx);
          body.innerHTML = `<h3>Order placed ✓</h3>
            <p class="cnote">${amtInput.value} USDC on ${side.toUpperCase()}, on Polymarket.</p>
            <p class="chain-sig">tx: <a href="https://explorer.solana.com/tx/${signature}" target="_blank" rel="noopener">${short(signature)} ↗</a></p>
            <button class="cclose">Done</button>`;
          body.querySelector(".cclose").onclick = () => body.closest(".cdim").remove();
        } catch (e) {
          stakeBtn.disabled = false; stakeBtn.textContent = "Put USDC on it";
          if (line) line.textContent = e.message || "Something went wrong — try again.";
        }
      };
    };
    render();
  }

  function attachButton(card) {
    if (card.querySelector(".chain-cta")) return; // already decorated
    const duel = card.querySelector(".duel");
    if (!duel) return;
    const slug = card.dataset.slug;
    const btn = document.createElement("button");
    btn.className = "chain-cta"; btn.type = "button";
    btn.textContent = "🔗 Make it real";
    btn.onclick = (e) => { e.stopPropagation(); openStakeSheet(slug); };
    duel.after(btn);
  }

  /**
   * The venue (Polymarket-via-Jupiter) real-money button. Separate from
   * attachButton above and deliberately NOT merged with it: the two paths
   * differ in contract, in endpoint, and — the part that actually matters —
   * in geofence. Our own parimutuel blocks nobody; the venue path blocks 19
   * countries including the entire US, fails closed on an unresolvable IP,
   * and additionally requires the master flag. `venueAllowed` is resolved
   * ONCE per page from /api/venue/status (which applies exactly the same
   * server-side gate that /api/venue/order/prepare enforces), so a blocked
   * visitor never sees the control at all — and if a stale page ever did
   * show it, the prepare call still refuses with 451.
   */
  let venueAllowed = null; // null = not yet asked
  async function venueIsAllowed() {
    if (venueAllowed !== null) return venueAllowed;
    try {
      const r = await fetch("/api/venue/status");
      const j = await r.json();
      venueAllowed = !!j.enabled;
    } catch (e) { venueAllowed = false; }
    return venueAllowed;
  }

  function attachVenueButton(card) {
    if (card.querySelector(".chain-cta")) return;
    const duel = card.querySelector(".duel");
    if (!duel) return;
    const marketId = card.dataset.venueId;
    if (!marketId) return;
    const btn = document.createElement("button");
    btn.className = "chain-cta"; btn.type = "button";
    btn.textContent = "🔗 Make it real";
    btn.onclick = (e) => { e.stopPropagation(); openVenueSheet(marketId, card); };
    duel.after(btn);
  }

  async function scan() {
    document.querySelectorAll('.card[data-community="1"]').forEach(attachButton);
    mountClaimCheck();
    // Venue cards are decorated only once the server says this visitor may
    // use that path at all — no flash of a button that would 451 on tap.
    if (await venueIsAllowed()) {
      document.querySelectorAll('.card[data-venue="polymarket"]').forEach(attachVenueButton);
    }
  }

  /**
   * The claim entry point, on Positions — where someone goes to look at what
   * they're holding, and therefore where they'd look for money they're owed.
   *
   * It has to be wallet-initiated rather than pushed: a resolved market leaves
   * the feed, and the server can't tell a staker they won because it never
   * stores which wallet belongs to which device. So Positions offers the
   * check, the user connects, and we ask the chain on their behalf. Rendered
   * only on the Positions view, only once, and silent when there's nothing to
   * collect — a permanent "no winnings" banner is clutter, not information.
   */
  async function mountClaimCheck() {
    if (document.body.dataset.view !== "positions") return;
    const host = document.querySelector("#scroller .sheet") || document.getElementById("scroller");
    if (!host || host.querySelector("#chainclaimcheck")) return;

    const box = document.createElement("div");
    box.id = "chainclaimcheck"; box.className = "chain-claimcheck";
    host.prepend(box);

    const paint = (html) => { box.innerHTML = html; };
    if (!wallet) {
      paint(`<div class="cc-row"><span class="cc-text">Staked real SOL on a market? Check if you have winnings to collect.</span>
        <button class="cc-go" type="button">Check</button></div>`);
      box.querySelector(".cc-go").onclick = async () => {
        const b = box.querySelector(".cc-go");
        b.disabled = true; b.textContent = "Connecting…";
        try { await connectWallet(); await refreshClaimable(box); }
        catch (e) { b.disabled = false; b.textContent = "Check"; paint(`<div class="cc-row"><span class="cc-text">${esc(e.message)}</span></div>`); }
      };
      return;
    }
    await refreshClaimable(box);
  }

  async function refreshClaimable(box) {
    box.innerHTML = `<div class="cc-row"><span class="cc-text">Checking ${CLUSTER_LABEL} for winnings…</span></div>`;
    let list = [];
    try {
      const r = await fetch(`/api/chain/claimable?userPubkey=${encodeURIComponent(wallet.publicKey)}`);
      const j = await r.json();
      list = j.ok ? j.claimable : [];
    } catch (e) { list = []; }
    if (!list.length) { box.remove(); return; }   // nothing owed -> say nothing
    box.innerHTML = `<div class="cc-head">💰 You have winnings to collect</div>` + list.map((c) => `
      <div class="cc-item">
        <span class="cc-q">${esc(c.question)}</span>
        <span class="cc-meta">called ${c.side.toUpperCase()} · ${(c.lamports / 1e9).toFixed(3)} SOL staked</span>
        <button class="cc-claim" type="button" data-slug="${esc(c.slug)}">Claim</button>
      </div>`).join("");
    box.querySelectorAll(".cc-claim").forEach((b) => b.onclick = () => openStakeSheet(b.dataset.slug));
  }

  function init() {
    scan();
    const scroller = document.getElementById("scroller");
    if (scroller) new MutationObserver(scan).observe(scroller, { childList: true, subtree: true });
  }

  window.OddieChain = { init };
})();
