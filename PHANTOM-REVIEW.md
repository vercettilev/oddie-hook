# Phantom dApp Review, hazır cevaplar

Form: https://docs.google.com/forms/d/e/1FAIpQLSeoSDtQc9CEHG-dC2EUO6ZkDCaFQXq3M92M1csH4WrdCCW-QQ/viewform

(Eski `/forms/d/1JgIxdmolgh.../viewform` adresi buraya 301 veriyor; ikisi de aynı forma çıkıyor.)

Zorunlu "Transaction Link" alanı tamamlanmış bir işlem istiyordu ve artık elimizde var:
mainnet'te, kullanıcının kendi cüzdanının imzaladığı, başarılı bir bahis. Aşağıda.

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
Deployed and live on mainnet-beta, with real SOL staked.
```

## dApp website URL

```
https://oddie.fun
```

## Your Name

```
Levent Acar
```

## Your E-mail

```
lev@oddie.fun
```

## Transaction Link

```
https://solscan.io/tx/4YMR3gX5cU4pEYvsg13UeNos116c47DiQsF752yEWmLeG6aZzVRPN2ur4WivdKn5W7kpbNEamUesqHZkygTc4Cg5
```

Mainnet, 10 Eylül 2026 08:55 UTC, SUCCESS. Solscan'de açılıp doğrulandı: imzalayan
`NYRhPxg68SvTR8XjEcEmXrjaB9uspeYaSuks3mxM1yc` yani kullanıcının kendi cüzdanı, tek
transfer 0.1 SOL kullanıcıdan market vault'una (`H58xTnbG712CN2fbyiTp9vwPMGgJQeVRZAWco1mUuuwW`),
çağrılan talimat `take_position`. `?cluster=` eki YOK, çünkü mainnet.

Marketteki dört imzanın ikisi bizim sunucu anahtarımızın (`create_market` ve
`migrate_position`) ve incelemeye gönderilemez. Kullanıcının imzaladığı iki tanesi var,
ikisi de geçerli; bu yenisi seçildi çünkü bugünkü, yani şu an yayında olan kodun ürünü,
ve Solscan'de tek bir temiz transfer olarak okunuyor. Eskisi (8 Eylül, aynı şekilde
geçerli, iki transfer çünkü pozisyon hesabını da o açtı):
`4RDF2VcJHWZ1WmdBBt9aLgyWjBZcfLnPEPy2s6ugwKDf9kw4tEJQ2eNCWyUdjJnrRJnDPEufxa9XxRzV6BUCUPhM`

Bu alanın neden bu kadar önemli olduğu: incelemeciye "uyarıyı kaldırın" demiyoruz,
tarayıcısının taradığı şeyin temiz olduğunu gösteriyoruz. Devnet linki bunu yapmaz,
başarısız bir işlem linki ise tam tersini yapar.

İşlemin ölçülmüş içeriği (yukarıdaki 1. maddenin dayanağı, zincirden okundu):
1 imza, 1 zorunlu imzacı, 6 talimat. Bizim olan iki tanesi ComputeBudget
setComputeUnitPrice (10.000 microLamports) ve `oddie_chain` çağrısı; diğer dördü
Phantom'un kendi Lighthouse koruma talimatları. Bir önceki sürüm bu alanda "tek talimat,
319 bayt, kendi ComputeBudget talimatımız yok" diyordu; üçü de artık yanlış.

İlgili diğer imzalar, sorulursa (ikisi de sunucu anahtarıyla):
- Market açılışı: `5h6GLLDPxW96bUpMwYrz6vMXLXimjDNJZAUfut9LovL73t3zfQgHMUivHFuwsmgcPFqm5iB2CiH6Wnd6fJ8bovWK`
- Hesap düzeni göçü: `2s4J2gxZHWZjM3qg9EgfzeJhMgZWE6KbuBPXB24pktuX35GJ3fwQnvp3BZxC37U1K2x3twso8a9nf46b5LbcUCqw`

## Solscan bizim talimatımızı ADIYLA göstermiyor

İncelemeci o sayfayı açtığında altı talimatın beşini isimleriyle görüyor (Compute Budget,
dört Lighthouse) ve bizimkini `#5 Unknown: Unknown` olarak görüyor. Sebep, IDL'in zincire
hiç yayınlanmamış olması; Solscan adı oradan okuyor.

Bu kritik değil, program id zaten açıklamada yazıyor, ama cüzdan incelemecisinin işi tam
olarak "bu ne" diye bakmak ve orada okuduğu kelime "Unknown". `anchor idl init` ile
yayınlanırsa aynı satır `take_position` yazar.

Bedeli ölçüldü: IDL 46KB, sıkıştırılmış 8.636 bayt, hesap ~8.680 bayt, **yaklaşık 0.12 SOL
kira**. Admin cüzdanında şu an 0.0970 SOL var, yani önce yükleme gerekiyor. Formu
göndermeyi bunun için bekletme; sonradan yayınlanınca aynı sayfa kendiliğinden düzelir.

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
Three things that may help the review. The first two are verifiable in the transaction
linked above.

1. Our side of the transaction is minimal, and it is a single signer. The linked stake
   carries one signature and one required signer, with the user as fee payer. Two of its
   six instructions are ours: a ComputeBudget setComputeUnitPrice at 10,000 microLamports,
   and one call to our own program. The other four are Lighthouse guard instructions your
   own wallet adds at signing time. There is no multi-signer flow and no oversized
   transaction anywhere in this dApp, so the developer remedies in your domain and
   transaction warning documentation do not apply to us: we already use a single signer
   and signTransaction rather than signAndSendTransaction.

2. We found and fixed a real cause on our side rather than only asking for a review. Our
   prepare endpoints did not validate on-chain preconditions before returning a signable
   transaction, so in some states (claiming with no position, collecting a fee as a
   non-creator, staking a market already past its on-chain close time) they handed the
   wallet a transaction that was guaranteed to revert. Your documentation notes that a
   transaction which would fail on chain triggers the warning. All three endpoints now
   mirror the program's own guards and refuse with an explanation instead.

3. Public betting is currently gated while we run a closed beta, so a reviewer visiting
   the site today will reach a market page that says betting opens shortly rather than a
   stake sheet. The linked transaction is a real mainnet stake through the exact flow in
   question. If it would help the review to walk that flow yourselves, tell us and we will
   open access immediately.

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
