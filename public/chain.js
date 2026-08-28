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
// user's funds. The user's own wallet SIGNS, and the server relays the signed
// bytes to the cluster this app runs on, because a wallet broadcasts to
// whatever cluster it happens to be set to. Only the wallet can sign. This
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
      s.onerror = () => reject(new Error("Couldn't load the Solana library. Check your connection and try again."));
      document.head.appendChild(s);
    });
    web3 = window.solanaWeb3;
    return web3;
  }

  /**
 * Sign with the wallet, broadcast through us.
 *
 * This was window.solana.signAndSendTransaction, which hands BROADCASTING to
 * the wallet, and a wallet broadcasts to whatever cluster it is set to. Almost
 * every visitor runs Phantom on mainnet while this app runs on devnet, so every
 * stake was aimed at a cluster where the program does not exist: Phantom could
 * not simulate it, showed its red "could be malicious" banner, and the bet died
 * at the wallet. Fifteen live markets, zero SOL, and that is the whole reason.
 *
 * signTransaction only signs. The bytes then go to /api/chain/submit and land on
 * the cluster the app actually runs on, whatever the wallet is set to. The
 * wallet is still the only thing that can sign, which is the only part that
 * matters for custody.
 *
 * Returns {signature, confirmed}. confirmed:false means it WAS broadcast and
 * we could not watch it land, which is not a failure and must never be shown
 * as one: the program lets you add to a position on the same side, so inviting
 * a retry over a stake that is already on chain costs real money.
 */
const SUBMIT_ERROR = {
  "preflight-failed": "Solana would not accept this one. The market may have just closed or settled.",
  "expired": "That took too long to reach the network. Nothing was staked, so you can try again.",
  "malformed": "Something went wrong building that transaction. Try again.",
  "not-our-program": "That transaction is not one of ours.",
  "unsigned": "Your wallet did not sign it. Try again.",
  "rejected": "Solana rejected it, so nothing was staked.",
  "unavailable": "Solana is not answering right now. Try again in a moment.",
};
async function signAndSubmit(tx, onSigned){
  const w = window.solana;
  if (!w) throw new Error("No Solana wallet found. Install Phantom to put real SOL on a market.");
  if (typeof w.signTransaction !== "function") {
    throw new Error("This wallet cannot sign without sending. Phantom can.");
  }
  const signed = await w.signTransaction(tx);
  if (onSigned) onSigned();
  // Default options on purpose: the wallet has just signed, so requiring the
  // signature here turns a wallet that quietly returned an unsigned envelope
  // into an error we can name instead of bytes the cluster refuses later.
  const bytes = signed.serialize();
  let b64 = "";
  for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
  const r = await fetch("/api/chain/submit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ txBase64: btoa(b64) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(SUBMIT_ERROR[j && j.error] || SUBMIT_ERROR.unavailable);
  return { signature: j.signature, confirmed: j.confirmed !== false };
}

/**
 * A refused prepare, in words.
 *
 * The prepare routes now check every rule the program enforces BEFORE handing
 * over a signable transaction, so these are the states where we stop rather
 * than let the wallet show a red "could be malicious" banner over something
 * that was always going to revert. Each one is a real answer, not an error.
 */
const PREPARE_REASON = {
  "closed": "Betting on this one has closed. The result is being settled.",
  "already-resolved": "This market has already settled.",
  "other-side": "You are already on the other side of this market. One side per wallet.",
  "not-resolved": "This market has not settled yet.",
  // After a claim the position account is CLOSED (that is what returns its
  // rent), so "no position" and "already collected" look identical from here.
  // The copy has to be true of both.
  "no-position": "Nothing to collect here. If you already claimed, it is in your wallet.",
  "already-claimed": "Already collected. It is in your wallet.",
  "lost": "This one went the other way, so there is nothing to collect.",
  "not-creator": "This market was tagged by a different wallet.",
  "nothing-owed": "No fee on this one: nobody backed the winning side.",
  "not-minted": "This market is not on chain yet.",
  "chain-unreachable": "Solana is not answering right now. Try again in a moment.",
};
function prepareError(pj, fallback){
  return new Error(PREPARE_REASON[pj && pj.reason] || (pj && pj.error) || fallback);
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Ask the server to put this market on chain, if it is not already. Purely a
   *  head start: /api/chain/position/prepare does the same thing on its own. */
  const ensured = new Set();
  function ensureOnChain(slug) {
    if (!slug || ensured.has(slug)) return;
    ensured.add(slug);
    fetch("/api/chain/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    }).catch(() => {});
  }

  async function connectWallet() {
    const provider = window.solana;
    if (!provider || !provider.isPhantom) {
      throw new Error("No Solana wallet found. Install Phantom to put real stake behind a call.");
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
  function payoutHint(side, sol, yesLamports, noLamports, feeBps, protoBps) {
    const mine = sol * 1e9;
    const same = (side === "yes" ? yesLamports : noLamports) + mine;
    const other = side === "yes" ? noLamports : yesLamports;
    const pool = same + other;
    // BOTH fees, because both are deducted before winners are paid. Quoting a
    // return against only one of them advertises money the vault will not have.
    const totalBps = (feeBps || 0) + (protoBps || 0);
    const distributable = pool - Math.floor((pool * totalBps) / 10000);
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
      shell(`<p class="cnote">Already collected. These winnings are in your wallet.</p>
        <button class="cclose">Close</button>`);
      return;
    }
    if ((position.side || "").toUpperCase() !== won) {
      shell(`<p class="cnote">You were on <b>${(position.side || "").toUpperCase()}</b> and it resolved <b>${won}</b>. Nothing to collect on this one.</p>
        <button class="cclose">Close</button>`);
      return;
    }

    const sol = (position.lamports / 1e9).toFixed(3);
    shell(`<p class="cnote">You called <b>${won}</b> with <b>${sol} SOL</b>, and you were right. Collect your winnings; your wallet signs, we never hold them.</p>
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
        if (!prep.ok || !pj.ok) throw prepareError(pj, "Couldn't prepare the claim.");
        const w3 = await loadWeb3();
        const tx = w3.Transaction.from(b64ToBytes(pj.txBase64));
        btn.textContent = "Confirm in wallet…";
        // The label has to move off "Confirm in wallet" the moment the wallet
        // is done, or it sits there stale while the server broadcasts.
        const { signature, confirmed } = await signAndSubmit(tx, () => { btn.textContent = "Broadcasting…"; });
        // The receipt is offered at the exact moment they feel like a genius,
        // because that is the moment they will actually post it. It opens as
        // its own page: the og image puts the card in the tweet, and posting it
        // is an ORIGINAL post, which is the format X actually ranks. The bot is
        // stuck in the replies; the winner is not.
        const receiptUrl = `/r/${encodeURIComponent(slug)}/${encodeURIComponent(wallet.publicKey)}`;
        body.innerHTML = `<h3>${confirmed ? "Collected ✓" : "Sent"}</h3>
          <p class="cnote">${confirmed
            ? `Your winnings are on their way to your wallet, on ${clusterLabel(CLUSTER)}.`
            : "It is on the network and we lost sight of it while it settled. Follow the link before collecting again."}</p>
          <p class="chain-sig">tx: <a href="${txUrl(signature, CLUSTER)}" target="_blank" rel="noopener">${short(signature)} ↗</a></p>
          ${confirmed ? `<a class="claimbtn" href="${receiptUrl}" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none">Show your receipt</a>` : ""}
          <button class="cclose">Done</button>`;
        body.querySelector(".cclose").onclick = () => body.closest(".cdim").remove();
      } catch (e) {
        btn.disabled = false; btn.textContent = "Claim winnings";
        if (line) line.textContent = e.message || "Something went wrong. Try again.";
      }
    };
  }

  /**
   * @param presetSide "yes" | "no" | null. Set when the sheet was opened by
   * tapping a side on the card itself, which is the normal path: that tap IS
   * the decision, and asking for it again inside the sheet would make the
   * card's buttons decorative.
   */
  async function openStakeSheet(slug, presetSide) {
    const body = sheetShell();
    // The question the money is going on. The sheet covers the card that was
    // just tapped, so without this the screen that takes a stake never states
    // what the stake is about: a swipe feed makes it genuinely easy to bet on
    // the market you scrolled past rather than the one you meant.
    const qEl = document.querySelector(`.card[data-slug="${slug}"] .take`);
    const question = qEl ? qEl.textContent.trim() : "";
    const titleHTML = question ? `<h3 class="chain-q">${esc(question)}</h3>` : `<h3>Pick a side</h3>`;
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
    // wallet signs and the server relays; the admin key is never involved.
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
      ? `<p class="chain-pool-empty">Nothing staked yet. First in sets the line.</p>`
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
    const protoBps = marketState.realProtocolFeeBps || 0;
    // Demoted to a footnote under the button. It is true and worth saying, but
    // it is a fact about somebody else's earnings, and it was sitting in the
    // third of three paragraphs a person had to read before reaching YES.
    const feeNoteHTML = feeBps
      ? `<p class="chain-fee-note">${(feeBps / 100).toFixed(0)}% of the pool goes to whoever started this market${protoBps ? `, ${(protoBps / 100).toFixed(0)}% to oddie` : ""}. Winners split the rest.</p>`
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
        ${titleHTML}
        <p class="cnote">${testnet ? `Test SOL on ${label}` : "Real SOL"}. Winners split the pool.</p>
        ${onchainOddsHTML}
        <div class="chain-side-row">
          <button class="chain-side" data-side="yes" type="button">YES</button>
          <button class="chain-side" data-side="no" type="button">NO</button>
        </div>
        <div class="chain-amt-lab">How much?</div>
        <div class="chain-amt-row">
          ${PRESETS.map((p) => `<button class="chain-chip" data-sol="${p}" type="button">${p} SOL</button>`).join("")}
          <button class="chain-chip chain-chip--other" data-sol="custom" type="button">Other</button>
        </div>
        <input class="chain-amt" type="number" min="0.001" step="0.001" placeholder="SOL amount" inputmode="decimal" hidden>
        <div class="chain-line" id="chainline"></div>
        <button class="claimbtn" id="chainstake" disabled>Pick a side</button>
        ${feeNoteHTML}
        ${wallet ? `<p class="chain-wallet">Wallet: <b>${short(wallet.publicKey)}</b></p>` : ""}
        <button class="cclose">Not now</button>`;
      body.querySelector(".cclose").onclick = () => body.closest(".cdim").remove();

      let side = presetSide === "yes" || presetSide === "no" ? presetSide : null, sol = 0;
      const sideBtns = [...body.querySelectorAll(".chain-side")];
      if (side) sideBtns.forEach((b) => b.classList.toggle("on", b.dataset.side === side));
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
            ? payoutHint(side, sol, yesLamports, noLamports, feeBps, protoBps)
            : "";
        }
      };

      sideBtns.forEach((b) => b.onclick = () => {
        side = b.dataset.side;
        // Picking a side is the earliest moment we know somebody means it, and
        // markets the bot opened have no on-chain account until somebody does.
        // Fired here, the mint happens while they are still typing an amount and
        // approving in Phantom, so nobody ever waits on it. Not awaited and its
        // failure is not shown: the stake path mints on its own if this did not,
        // so the only thing lost is a head start.
        ensureOnChain(slug);
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

      // Run once now, not only on the next interaction. The button ships from
      // innerHTML reading "Pick a side", which is right when nothing is chosen
      // and wrong the moment a side arrives pre-picked from the card: it asked
      // for a decision the user had already made one tap earlier.
      refresh();

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
          if (!prep.ok || !pj.ok) throw prepareError(pj, "Couldn't prepare the transaction.");
          const w3 = await loadWeb3();
          const tx = w3.Transaction.from(b64ToBytes(pj.txBase64));
          stakeBtn.textContent = "Confirm in wallet…";
          const { signature, confirmed } = await signAndSubmit(tx, () => { stakeBtn.textContent = "Broadcasting…"; });
          // confirmed:false means it WAS broadcast and we could not watch it
          // land. Never render that as a failure: the program allows adding to
          // a position on the same side, so a retry over a stake that is
          // already on chain would take their money twice.
          body.innerHTML = `<h3>${confirmed ? "You're in ✓" : "Sent"}</h3>
            <p class="cnote">${confirmed
              ? `${sol} SOL on ${side.toUpperCase()}${testnet ? `, on ${label}` : ""}.`
              : `${sol} SOL on ${side.toUpperCase()} is on the network. We lost sight of it while it settled, so check the link before staking again.`}</p>
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

  /**
   * Community cards get no extra button any more.
   *
   * This used to inject a "🔗 Make it real" CTA under the duel, which was
   * right while the card's own YES/NO spent play tokens and real SOL was a
   * separate opt-in. Under one economy it leaves two ways to bet on one card,
   * and labels one of them as though the other were pretend. The card's
   * buttons are the entry point; feed.html routes them to openStake.
   *
   * Kept as a function so scan() keeps a place to decorate community cards
   * from, which is where the live pool odds get written in.
   */
  function attachButton(card) {
    const old = card.querySelector(".chain-cta");
    if (old) old.remove();   // clears the button from a cached earlier build
    paintPoolOdds(card);
  }

  /**
   * Put the VAULT's odds on the card, over the play pool's.
   *
   * The percentages and the multiplier a community card ships are computed
   * from the free-predictions crowd. That was fine when those predictions were
   * the game. Now the only money on the market is in the vault, so the card
   * was advertising one set of odds and the bet sheet quoting another, for the
   * same question, a tap apart. The vault's number is the one somebody is
   * about to be paid from, so it wins.
   *
   * Written per card as it is decorated, and silent on failure: a card whose
   * chain read did not come back keeps the numbers it rendered with rather
   * than blanking, because a card with no odds at all is worse than a card
   * with stale ones, and the sheet reads the chain again before any money
   * moves regardless.
   *
   * An empty vault is marked rather than left showing 50/50. Nobody has priced
   * this yet, and a made-up midpoint is the one number here that could not
   * possibly be right.
   */
  async function paintPoolOdds(card) {
    if (card.dataset.chainOdds === "done") return;
    card.dataset.chainOdds = "done";
    const slug = card.dataset.slug;
    if (!slug) return;
    let s;
    try {
      const r = await fetch(`/api/chain/market/${encodeURIComponent(slug)}`);
      s = await r.json();
      if (!s.ok) return;
    } catch (e) { return; }

    const yes = s.totalYesLamports || 0, no = s.totalNoLamports || 0;

    // The card ships a stake line whose pool half is a placeholder, because
    // only the vault knows the total. This is the one fetch that already has
    // it, so it fills it in rather than costing a second round trip.
    const poolEl = card.querySelector(".stakeline-pool");
    if (poolEl) {
      const total = (yes + no) / 1e9;
      poolEl.textContent = total > 0
        ? `${total.toFixed(total < 1 ? 3 : 2)} SOL in the pool`
        : "real SOL, winners split the pool";
    }

    const rows = card.querySelectorAll(".duel .orow");
    if (rows.length !== 2) return;
    const pct = poolPct(yes, no);

    if (pct == null) {
      // No stake either side. Say so once, on the card, instead of letting the
      // play pool's 50/50 pass for a price.
      rows.forEach((row) => {
        const pay = row.querySelector(".opay");
        if (pay) pay.textContent = "first in";
      });
      card.dataset.chainPool = "empty";
      return;
    }
    const vals = { yes: pct, no: 100 - pct };
    rows.forEach((row) => {
      const side = row.dataset.side;
      const v = vals[side];
      if (v == null) return;
      const num = row.querySelector(".opct-num");
      if (num) { num.textContent = String(v); num.dataset.to = String(v); }
      const pay = row.querySelector(".opay");
      if (pay) pay.textContent = fmtMult(v);
      row.style.setProperty("--fill", v + "%");
    });
    card.dataset.chainPool = "live";
  }

  function scan() {
    document.querySelectorAll('.card[data-community="1"]').forEach(attachButton);
    mountClaimCheck();
    mountCreatorFees();
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

  /**
   * The creator fee, collected. The half of the economy oddie advertises.
   *
   * "Tag an argument and you earn when it resolves" has been on the landing
   * page, on every market card and in every reply oddie posts, and until now
   * there was no screen anywhere in the product where that money could be
   * taken. The program held it, the routes returned it, nothing asked for it.
   *
   * Lives on My markets, which is where somebody goes to look at the markets
   * they started, and therefore where they would look for what those markets
   * paid. Wallet-initiated for the same reason the winnings check is: the fee
   * is owed to an on-chain address, the server never learns which wallet
   * belongs to which device, so it has to be asked on the user's behalf after
   * they connect.
   *
   * Connecting is also what NAMES them on chain. A market minted before its
   * tagger had a wallet carries the program's unnamed creator, and
   * /api/auth/wallet/verify writes the real address the moment one is linked.
   * So a first connect here can legitimately return nothing and a later visit
   * return money, which is why the empty state does not say "you have earned
   * nothing".
   */
  async function mountCreatorFees() {
    if (document.body.dataset.view !== "mymarkets") return;
    const host = document.querySelector("#scroller .sheet") || document.getElementById("scroller");
    if (!host || host.querySelector("#chaincreatorfees")) return;

    const box = document.createElement("div");
    box.id = "chaincreatorfees"; box.className = "chain-claimcheck";
    host.prepend(box);

    if (!wallet) {
      box.innerHTML = `<div class="cc-row"><span class="cc-text">Markets you started pay you 2% when they resolve. Connect the wallet you want paid to.</span>
        <button class="cc-go" type="button">Connect</button></div>`;
      box.querySelector(".cc-go").onclick = async () => {
        const b = box.querySelector(".cc-go");
        b.disabled = true; b.textContent = "Connecting…";
        try { await connectWallet(); await refreshCreatorFees(box); }
        catch (e) {
          b.disabled = false; b.textContent = "Connect";
          box.innerHTML = `<div class="cc-row"><span class="cc-text">${esc(e.message)}</span></div>`;
        }
      };
      return;
    }
    await refreshCreatorFees(box);
  }

  async function refreshCreatorFees(box) {
    box.innerHTML = `<div class="cc-row"><span class="cc-text">Checking what your markets earned…</span></div>`;
    let list = [];
    try {
      const r = await fetch(`/api/chain/creator-fees?creatorPubkey=${encodeURIComponent(wallet.publicKey)}`);
      const j = await r.json();
      list = j.ok ? j.fees : [];
    } catch (e) { list = []; }
    // Nothing owed says nothing. A permanent "no fees yet" panel on a screen
    // full of markets that have not resolved is clutter, not information.
    if (!list.length) { box.remove(); return; }

    const total = list.reduce((a, f) => a + f.lamports, 0) / 1e9;
    box.innerHTML = `<div class="cc-head">🏷️ ${total.toFixed(3)} SOL earned from markets you started</div>` + list.map((f) => `
      <div class="cc-item">
        <span class="cc-q">${esc(f.question)}</span>
        <span class="cc-meta">${(f.feeBps / 100).toFixed(0)}% of the pool · ${(f.lamports / 1e9).toFixed(3)} SOL</span>
        <button class="cc-claim" type="button" data-slug="${esc(f.slug)}">Collect</button>
      </div>`).join("");

    box.querySelectorAll(".cc-claim").forEach((b) => b.onclick = async () => {
      b.disabled = true; b.textContent = "Preparing…";
      try {
        const prep = await fetch("/api/chain/creator-fee/prepare", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: b.dataset.slug, creatorPubkey: wallet.publicKey }),
        });
        const pj = await prep.json();
        if (!prep.ok || !pj.ok) throw prepareError(pj, "Couldn't prepare the transaction.");
        const w3 = await loadWeb3();
        const tx = w3.Transaction.from(b64ToBytes(pj.txBase64));
        b.textContent = "Confirm…";
        const { signature, confirmed } = await signAndSubmit(tx, () => { b.textContent = "Sending…"; });
        const row = b.closest(".cc-item");
        row.innerHTML = `<span class="cc-q">${confirmed ? "Collected ✓" : "Sent"}</span>
          <span class="cc-meta"><a href="${txUrl(signature, CLUSTER)}" target="_blank" rel="noopener">${short(signature)} ↗</a></span>`;
      } catch (e) {
        b.disabled = false; b.textContent = "Collect";
        const meta = b.closest(".cc-item").querySelector(".cc-meta");
        if (meta) meta.textContent = e.message || "Something went wrong, try again.";
      }
    });
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

  // openStake is what feed.html's card buttons call. Exposed rather than left
  // to the injected "Make it real" button, because that button was the entry
  // point back when real money was an optional layer beside the card's own
  // YES/NO. With one economy there is one pair of buttons, and they are the
  // ones already on the card.
  window.OddieChain = { init, openStake: openStakeSheet };
})();
