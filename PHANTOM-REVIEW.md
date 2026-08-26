# Phantom dApp Review, hazır cevaplar

Form: https://docs.google.com/forms/d/1JgIxdmolgh_80xMfQKBKx9-QPC7LRdN6LHpFFW8BlKM/viewform

**Göndermeden önce oku:** zorunlu "Transaction Link" alanı tamamlanmış bir işlem istiyor.
Başarısız bir işlemin linkini vermek, incelemecinin taradığı şeyin kanıtını sunmak olur.
Önce bir tane temiz işlem üret (aşağıda "Transaction Link" bölümü), sonra gönder.

---

## Project Name

```
oddie
```

## Describe your dApp

```
oddie turns arguments on X into real prediction markets.

Someone tags @oddiefun under a claim on X. That mints a pari-mutuel market on our own
Anchor program on Solana, and the market appears in a feed where anyone can take a side
with SOL from their own wallet. When it settles, winners split the pool.

oddie is non-custodial by design. It never holds user funds and never takes custody of a
key. Every stake, claim and fee collection is a transaction the user's own wallet signs
and broadcasts. The vault is a program-derived account; we cannot move what is in it
outside the program's rules.

Fees are 4% of the pool, taken once at settlement, never per trade: 2% to the person who
tagged the market into existence and 2% to the protocol. Both rates are stored on the
market at creation, so changing a rate later can never reprice a market people have
already staked into.

Main surfaces: a feed of live markets, a stake sheet, a claim flow for winners, and a
creator fee collection flow for the person who started the market.

Program id: 3SYG7hzQBYGc853BGTxcBtTLefESaP9DqP5aHbvgnYsu
Currently deployed on devnet. Mainnet deploy is next.
```

## dApp website URL

```
https://oddie.fun
```

## Your Name

```
<senin adın>
```

## Your E-mail

```
<formda zaten seçili olan adres>
```

## Transaction Link

**Bu alan için önce bir işlem gerekiyor.** Şu an elimizde temiz bir tane yok, sebebi ve
çözümü aşağıda. Üretince Solscan linkini buraya koy:

```
https://solscan.io/tx/<signature>?cluster=devnet
```

Nasıl üretilir:
1. Phantom'u devnet'e al (Settings, Developer Settings, Change Network, Devnet)
2. Devnet SOL al (https://faucet.solana.com)
3. oddie.fun/feed üzerinden bir markete bahis koy
4. İşlem başarılı olunca Solscan linkini al

Mainnet'e geçtikten sonra doldurmayı tercih edersen, o zaman `?cluster=devnet` ekini
kaldır. Mainnet işlemi daha güçlü bir kanıt olur.

## Team Information

```
Website: https://oddie.fun
Builder: https://x.com/levvercetti
Product account: https://x.com/oddiefun

oddie is built and operated by a small independent team. The Solana program is our own
Anchor program, not a fork, and the full stack (program, backend, client) is ours.
```

## Social Media Handles

```
X (product): https://x.com/oddiefun
X (builder): https://x.com/levvercetti
```

## Repository Links

Ana repo private. Kamuya açık tek teknik artefakt:

```
https://github.com/Clawpump/agents-skills/pull/9

An open pull request adding oddie as a skill to ClawPump's public agent skills
repository. The main application repository is private.
```

> Repoyu public yapmayı düşünürsen bu alan çok daha güçlü olur. Değerlendirmeye değer,
> ama kendi kararın: private kalması gereken bir şey varsa (env örnekleri, admin route'ları)
> önce onu temizlemek gerekir.

## Do you have a community member who can vouch for your team/project?

```
<FairClub veya AnsemHack tarafından bir isim + iletişim>
```

> Bu alan formdaki en güçlü kaldıraç. Boş bırakma. FairClub görüşmen ve AnsemHack kaydın
> varken tanıyan birini bulmak zor olmamalı.

## Any additional information you'd like to share?

```
Two things that may help the review, both verifiable.

1. Our transactions are deliberately minimal. A stake is one required signature, one
   instruction, 319 bytes serialized, with the user as fee payer. We add no compute
   budget instructions of our own. Every developer remedy in your domain and transaction
   warnings documentation (single signer, signTransaction over signAndSendTransaction for
   multi-signer flows, splitting oversized transactions) is already satisfied, so there
   is no multi-signer or size condition behind the simulation warning we were seeing.

2. We found and fixed a real cause on our side rather than only asking for a review. Our
   prepare endpoints did not validate on-chain preconditions before returning a signable
   transaction, so in some states (claiming with no position, collecting a fee as a
   non-creator, staking a market already past its on-chain close time) they handed the
   wallet a transaction that was guaranteed to revert. Your documentation notes that a
   transaction which would fail on chain triggers the warning. All three endpoints now
   mirror the program's own guards and refuse with an explanation instead.

The domain is new (registered 2026-07-13), which we understand accounts for the new
domain notice on its own.
```

---

## Gönderdikten sonra

- Alan adı incelemesi **alan adına** bağlı, koda değil. Mainnet'e geçmek alan adını
  değiştirmediği için tekrar doldurman gerekmemeli. Bu Phantom'un dokümanında yazmıyor,
  sistemin girdilerinden çıkan sonuç.
- Onay ekranındaki "Failed to simulate" uyarısı bir onay belgesi değil: Phantom her işlemi
  her seferinde yeniden simüle ediyor. Onun çözümü bu form değil, yukarıdaki 2. maddede
  anlatılan kod düzeltmesi, ve o zaten yapıldı.
