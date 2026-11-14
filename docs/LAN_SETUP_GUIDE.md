# Using BrainTech Pharmacy AI on several computers (LAN setup guide)

This guide is for pharmacy owners and staff. No internet connection is needed: the computers only need to be connected to the **same router**, by Wi-Fi or cable.

> **Status (Phase 4):** host/client mode works and has been tested automatically with two copies of the app on one Linux computer. It has **not yet been tested on real Windows computers or across a real Wi-Fi network**. Please follow the manual test list in `TESTING_REPORT.md` before using it in the pharmacy.

## 1. Choose the main computer (the "server")

Pick the computer that:
- is switched on whenever the pharmacy is open;
- is connected to the router, preferably with a cable;
- has enough free disk space and a reliable power supply (a UPS is recommended).

All pharmacy data is stored **only on this computer**. The other computers ("clients") store no pharmacy data. If the main computer is off, the other computers cannot make sales. This is intentional: it keeps stock and invoices correct everywhere.

## 2. Set up the main computer

1. Install BrainTech Pharmacy AI and open it.
2. Choose **Main pharmacy server**.
3. Choose one of:
   - **Start a new pharmacy**, then enter the pharmacy name and create the administrator account (your own username and a strong password); or
   - **Import from the previous version**, then choose the old `khushi_pharmacy.sqlite` file. The file is **copied**; the original is never changed, and existing users keep their passwords.
4. When Windows asks whether to allow the app on **Private networks**, click **Allow**. Do **not** allow Public networks.
5. Open **File › Connection & Server Settings**. Note down:
   - the **address**, for example `192.168.1.20`;
   - the **port** (normally `3747`);
   - the 8-character **pairing code** (valid for 10 minutes; click *New code* for another).

## 3. Connect each other computer

1. Install BrainTech Pharmacy AI and open it.
2. Choose **Connect to the pharmacy server**.
3. If the main computer appears in the list, click it. If it does not (many routers block this search), type the **address** and **port** yourself.
4. Type the **pairing code** shown on the main computer and a name for this computer (for example "Billing Counter").
5. Click **Pair and connect**, then **Open the pharmacy**, and sign in with your usual pharmacy account.

**Why the pairing code?** Pairing proves to both computers that they are talking to each other, and not to another device on the network pretending to be the server. After pairing, everything sent between the computers is encrypted.

## 4. Everyday use

| Situation | What happens |
|---|---|
| A sale is made on any computer | Stock and invoices change on the main computer immediately; the other computers see the change the next time they load the list (automatic live refresh is planned for Phase 8) |
| Wi-Fi drops, or the main computer is switched off | The other computers show **"Pharmacy server unreachable - reconnecting…"** and block selling. They reconnect by themselves when it is back. |
| The connection drops **while a sale is being saved** | The screen shows **SALE NOT CONFIRMED** and keeps the cart. Do not hand over the receipt yet. **Check status** shows whether the sale was saved. **Retry sale** is always safe: the same sale can never be recorded twice. |
| "Security certificate changed" | The main computer was reinstalled or its certificate renewed, or another device is pretending to be the server. Ask the administrator, then pair this computer again. |
| "Different software versions" | Install the same version on all computers. Since Phase 7 Batch 2b the host uses **protocol 4** (check `https://<host>:3747/api/health` → `"apiProtocol":4`); update the host and every client together. |

## 5. Removing a computer

On the main computer: **File › Connection & Server Settings › Paired computers › Remove**. That computer can no longer connect until it is paired again (useful for a lost or sold laptop).

## 6. Windows Firewall

The main computer must accept connections on **TCP port 3747** (pharmacy data, encrypted) and **UDP port 3748** (finding the server automatically; optional), **on Private networks only**.

Normally Windows asks the first time; choose **Private networks** and **Allow**. If you clicked *Cancel* by mistake, an administrator can add the rules:

1. Open **Windows Defender Firewall with Advanced Security**.
2. **Inbound Rules › New Rule › Program**, choose `BrainTech Pharmacy AI.exe`, **Allow the connection**, tick **Private** only.

The installer will offer to add these rules automatically (Phase 11, not yet available).

Your Wi-Fi network must be set to **Private** (Windows Settings › Network & Internet › your Wi-Fi › Network profile type › Private). On a **Public** network, Windows blocks other computers on purpose. Do not run the pharmacy on public or guest Wi-Fi.

## 7. Troubleshooting a connection

| Message / problem | Check |
|---|---|
| "No server answered" in the list | Normal on many routers. Type the address from the main computer's settings page. |
| "No answer from that address and port" | Is the main computer on and the app open? Same router? Firewall allows the app on **Private** networks? Is the address current (see below)? |
| "Pairing failed: the code is wrong, or the connection is being intercepted" | Codes change every 10 minutes and after 5 wrong tries. Click *New code* on the main computer and type it again carefully. |
| "Only computers on the local network may connect" | The client is reaching the server through a public address (VPN or mobile hotspot). Connect both to the pharmacy router. |
| Address changed after a router restart | Routers can give the main computer a new address. Use the new address shown in its settings page, or ask your technician to reserve a fixed address (DHCP reservation) for the main computer in the router. Pairing does not need to be repeated: trust is based on the certificate, not the address. |

## 8. Certificate renewal (administrators)

Each main computer creates its own security certificate on first start. It is valid for 5 years.

To replace it (suspected compromise, or after a reinstall), delete the `certs` folder in the data folder while the app is closed, then start the app. A new certificate is created, and **every client must be paired again**: each client shows "Security certificate changed" and offers *Connection settings*.

A one-click renewal with a grace period, where already-paired clients switch over automatically, is planned and is **not** in this version.

Data folder:
- Windows: `C:\ProgramData\BrainTechPharmacyAI\`
- if that is not writable: `%LOCALAPPDATA%\BrainTechPharmacyAI\`
