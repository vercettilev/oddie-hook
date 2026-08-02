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

  function sheetShell() {
    const dim = document.createElement("div");
    dim.className = "cdim chaindim";
    dim.innerHTML = `<div class="csheet chainsheet" role="dialog" aria-label="Make it real"></div>`;
    dim.onclick = (e) => { if (e.target === dim) dim.remove(); };
    document.body.appendChild(dim);
    return dim.querySelector(".chainsheet");
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
    if (marketState.resolved) {
      body.innerHTML = `<h3>Make it real</h3>
        <p class="cnote">This market already resolved ${(marketState.winningSide || "").toUpperCase()} on-chain.</p>
        <button class="cclose">Close</button>`;
      body.querySelector(".cclose").onclick = () => body.closest(".cdim").remove();
      return;
    }

    const render = () => {
      body.innerHTML = `
        <h3>Make it real</h3>
        <p class="cnote">Optional. Real SOL on ${CLUSTER_LABEL}, separate from your free predictions above — this never affects them, and it's never required to play.</p>
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

  function scan() {
    document.querySelectorAll('.card[data-community="1"]').forEach(attachButton);
  }

  function init() {
    scan();
    const scroller = document.getElementById("scroller");
    if (scroller) new MutationObserver(scan).observe(scroller, { childList: true, subtree: true });
  }

  window.OddieChain = { init };
})();
