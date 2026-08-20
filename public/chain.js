// Betting, with real SOL. Loaded only when /api/chain/status says the server
// can reach the chain (see initChainLayer() in feed.html, which injects this
// file's script tag and hands it the cluster). This file existing in a page
// load already means that answered yes; there is no further flag check inside
// it.
//
// It was written as an optional extra called "skin in the game", sitting
// beside a free play-token game that was the actual product, and much of the
// copy in here still needs reading with that in mind. It is not an extra any
// more. This is how a position is taken, the only way, and the sheets below
// should read like the main path rather than an upsell off one.
//
// Architecture, unchanged and worth keeping: the server ASSEMBLES
// take_position / claim_winnings / claim_creator_fee transactions (the
// /api/chain/* routes in server.ts) but never signs them and never holds a
// user's funds. The user's own wallet signs and broadcasts, client-side. This
// file talks to window.solana and to this app's own same-origin routes, and to
// nothing else. The one piece of real client-side Solana code it needs, for
// deserializing the server-built transaction bytes so the wallet can sign
// them, loads from a CDN lazily on the first actual bet rather than on page
// load: looking at odds should not cost a library fetch.
(function () {
  /** Stake sizes, in SOL. Small enough that the first one is not a decision. */
  const PRESETS = [0.05, 0.1, 0.25];

  /**
   * The network, from the server, never guessed here.
   *
   * This was the string "Solana devnet", written into the copy and again into
   * every explorer link. Hardcoding it survives exactly until the day the
   * server points at mainnet, and then it does the worst thing a label can do:
   * it tells somebody spending real money that they are on a test network, and
   * links them to an explorer page that shows nothing. The server reports its
   * own cluster on every market read; this only formats it.
   */
  function clusterLabel(c) {
    return c === "mainnet-beta" ? "Solana" : c === "testnet" ? "Solana testnet" : "Solana devnet";
  }
  function txUrl(sig, c) {
    const q = (c || "devnet") === "mainnet-beta" ? "" : `?cluster=${c || "devnet"}`;
    return `https://explorer.solana.com/tx/${sig}${q}`;
  }

  /** Set once from /api/chain/status before init() runs. Defaults to the
   *  safest wrong answer: mislabelling mainnet as devnet would be far worse
   *  than the reverse, so the default is the one that cannot understate risk. */
  let CLUSTER = "devnet";

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

  // Mirrors markets.ts's poolPct exactly (same clamp, same rounding), over the
  // vault's own lamports (Market.total_yes/total_no).
  //
  // This used to be one of two numbers. A market carried a play-token pool and
  // a real-SOL pool at once, and the comment here defended showing both: the
  // same market could read 70% YES in predictions and 30% YES in SOL, because
  // they were different people betting different things. That stopped being a
  // feature the moment real money became the only money. Two odds for one
  // question is now just a wrong number next to a right one, and the play
  // figure is the wrong one. This is the line.
  function poolPct(chosen, opposite) {
    const total = chosen + opposite;
    if (total <= 0) return null;
    return Math.max(1, Math.min(99, Math.round((chosen / total) * 100)));
  }
  function fmtMult(pct) { return (100 / pct).toFixed(1) + "×"; }

  /**
   * What this bet pays if it wins, at the odds as they stand right now.
   *
   * Mirrors the program's arithmetic (resolve_market then claim_winnings): the
   * fee comes off the whole pool first, and the rest is split across the
   * winning side in proportion to stake. Your own money is inside both of
   * those totals, which is the part people get wrong when they estimate it
   * themselves, and it is why the number moves as others join.
   *
   * A live estimate, not a promise, and it says so. Every later bet on the
   * other side raises it and every later bet on yours lowers it, so quoting it
   * as a fixed payout would be the one number in this sheet that is reliably
   * wrong by the time the market resolves.
   */
  function payoutHint(side, sol, yesLamports, noLamports, feeBps) {
    const mine = sol * 1e9;
    const same = (side === "yes" ? yesLamports : noLamports) + mine;
    const other = side === "yes" ? noLamports : yesLamports;
    const pool = same + other;
    const distributable = pool - Math.floor((pool * (feeBps || 0)) / 10000);
    const take = (mine / same) * distributable / 1e9;
    // A market with nothing on the other side pays you back your own stake
    // minus the fee, which is not a win and should not be dressed as one.
    if (other <= 0) return `Nothing on the other side yet, so this only pays if someone takes it.`;
    return `Wins about ${take.toFixed(3)} SOL at today's odds. Moves as others bet.`;
  }

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
      shell(`<p class="cnote">This market settled <b>${won}</b> on ${clusterLabel(CLUSTER)}. If you had real SOL on it, connect the wallet you staked with to collect.</p>
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
      shell(`<p class="cnote">Couldn't read your position from ${clusterLabel(CLUSTER)} just now. Your funds are unaffected, try again in a moment.</p>
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
          <p class="cnote">Your winnings are on their way to your wallet, on ${clusterLabel(CLUSTER)}.</p>
          <p class="chain-sig">tx: <a href="${txUrl(signature, CLUSTER)}" target="_blank" rel="noopener">${short(signature)} ↗</a></p>
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
      ? `<p class="chain-pool-empty">No real stake on this market yet. First in sets the line.</p>`
      : `<div class="chain-pool-odds">
           <span class="chain-pool-side">YES <b>${yesOnchainPct}%</b> <small>${fmtMult(yesOnchainPct)}</small></span>
           <span class="chain-pool-side">NO <b>${noOnchainPct}%</b> <small>${fmtMult(noOnchainPct)}</small></span>
         </div>`;

    // The fee, stated as the fact it now is. This used to read "proposed …
    // not yet deducted on-chain", which was honest while the deployed program
    // had no fee instruction. resolve_market takes it out of the pool now, so
    // hedging about it would be the lie in the other direction. The platform
    // rate is gone rather than printed as 0%: a line saying we charge nothing
    // invites the question of when we will start.
    const feeBps = marketState.realCreatorFeeBps || 0;
    const feeNoteHTML = feeBps
      ? `<p class="chain-fee-note">${(feeBps / 100).toFixed(0)}% of the pool goes to whoever started this market. Nothing goes to oddie.</p>`
      : "";

    const label = clusterLabel(CLUSTER);
    const testnet = CLUSTER !== "mainnet-beta";

    const render = () => {
      // ORDER MATTERS, and it is the opposite of what this sheet used to do.
      // Sides only appeared after connecting a wallet, which asked people to
      // hand over a wallet before they were shown the thing they came to
      // decide. Deciding is free and reversible; connecting is neither. So the
      // sides are always here, the amount is always here, and the wallet is
      // asked for at the last possible moment, by the same button that places
      // the bet.
      body.innerHTML = `
        <h3>Pick a side</h3>
        <p class="cnote">Real SOL${testnet ? ` on ${label}` : ""}. Winners split the pool.</p>
        ${onchainOddsHTML}
        ${feeNoteHTML}
        <div class="chain-side-row">
          <button class="chain-side" data-side="yes" type="button">YES</button>
          <button class="chain-side" data-side="no" type="button">NO</button>
        </div>
        <div class="chain-amt-row">
          ${PRESETS.map((p) => `<button class="chain-chip" data-sol="${p}" type="button">${p}</button>`).join("")}
          <button class="chain-chip" data-sol="custom" type="button">…</button>
        </div>
        <input class="chain-amt" type="number" min="0.001" step="0.001" placeholder="SOL amount" inputmode="decimal" hidden>
        <div class="chain-line" id="chainline"></div>
        <button class="claimbtn" id="chainstake" disabled>Pick a side</button>
        ${wallet ? `<p class="chain-wallet">Wallet: <b>${short(wallet.publicKey)}</b></p>` : ""}
        <button class="cclose">Not now</button>`;
      body.querySelector(".cclose").onclick = () => body.closest(".cdim").remove();

      let side = null, sol = 0;
      const sideBtns = [...body.querySelectorAll(".chain-side")];
      const chips = [...body.querySelectorAll(".chain-chip")];
      const amtInput = body.querySelector(".chain-amt");
      const stakeBtn = body.querySelector("#chainstake");
      const line = body.querySelector("#chainline");

      // ONE button, and it never dead-ends. Whatever is missing is what it
      // asks for next, so there is never a disabled control with no
      // explanation of what would enable it.
      const refresh = () => {
        if (!side) { stakeBtn.disabled = true; stakeBtn.textContent = "Pick a side"; }
        else if (!(sol > 0)) { stakeBtn.disabled = true; stakeBtn.textContent = "Choose an amount"; }
        else if (!wallet) { stakeBtn.disabled = false; stakeBtn.textContent = "Connect wallet to bet"; }
        else { stakeBtn.disabled = false; stakeBtn.textContent = `${side.toUpperCase()} · ${sol} SOL`; }
        // Ternary, not `a && b && f()`. That short-circuits to the boolean
        // `false` when either test fails, and textContent renders it as the
        // word "false" sitting under the odds. Caught in the browser; it is
        // invisible to every check that does not actually look at the sheet.
        if (line) {
          line.textContent = (side && sol > 0)
            ? payoutHint(side, sol, yesLamports, noLamports, feeBps)
            : "";
        }
      };

      sideBtns.forEach((b) => b.onclick = () => {
        side = b.dataset.side;
        sideBtns.forEach((x) => x.classList.toggle("on", x === b));
        refresh();
      });
      chips.forEach((c) => c.onclick = () => {
        chips.forEach((x) => x.classList.toggle("on", x === c));
        if (c.dataset.sol === "custom") {
          amtInput.hidden = false; amtInput.focus();
          sol = parseFloat(amtInput.value) || 0;
        } else {
          amtInput.hidden = true;
          sol = parseFloat(c.dataset.sol);
        }
        refresh();
      });
      amtInput.oninput = () => { sol = parseFloat(amtInput.value) || 0; refresh(); };

      stakeBtn.onclick = async () => {
        // The connect step is folded into the same button rather than being a
        // separate one earlier: someone who has already picked YES and 0.1 SOL
        // has decided, and the wallet prompt is now a confirmation of that
        // decision instead of a toll gate in front of it.
        if (!wallet) {
          stakeBtn.disabled = true; stakeBtn.textContent = "Check your wallet…";
          try { await connectWallet(); }
          catch (e) {
            stakeBtn.disabled = false; refresh();
            if (line) line.textContent = e.message;
            return;
          }
          const w = body.querySelector(".chain-wallet");
          if (!w) stakeBtn.insertAdjacentHTML("afterend", `<p class="chain-wallet">Wallet: <b>${short(wallet.publicKey)}</b></p>`);
          refresh();
          return; // one more tap to bet, so a wallet popup never becomes a spend
        }
        stakeBtn.disabled = true; stakeBtn.textContent = "Preparing…";
        try {
          const lamports = Math.round(sol * 1e9);
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
          body.innerHTML = `<h3>You're in ✓</h3>
            <p class="cnote">${sol} SOL on ${side.toUpperCase()}${testnet ? `, on ${label}` : ""}.</p>
            <p class="chain-sig">tx: <a href="${txUrl(signature, CLUSTER)}" target="_blank" rel="noopener">${short(signature)} ↗</a></p>
            <button class="cclose">Done</button>`;
          body.querySelector(".cclose").onclick = () => body.closest(".cdim").remove();
        } catch (e) {
          stakeBtn.disabled = false; refresh();
          if (line) line.textContent = e.message || "Something went wrong, try again.";
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
    box.innerHTML = `<div class="cc-row"><span class="cc-text">Checking ${clusterLabel(CLUSTER)} for winnings…</span></div>`;
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

  /** `cluster` comes from the same /api/chain/status response that decided to
   *  load this file at all, so the network named in the copy and the network
   *  the server is actually on cannot disagree. */
  function init(cluster) {
    if (cluster) CLUSTER = cluster;
    scan();
    const scroller = document.getElementById("scroller");
    if (scroller) new MutationObserver(scan).observe(scroller, { childList: true, subtree: true });
  }

  window.OddieChain = { init };
})();
