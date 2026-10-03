---
id: google-drive
title: Google Drive
category: Integrations
roles: OWNER, ADMIN, MEMBER, GUEST
plans: FREE, STANDARD, PREMIUM
keywords: google drive, drive upload, drive sharing, company drive, my drive, connect drive, drive link, upload to drive, who can open files, public drive links, switch account
---

Upload files to Google Drive instead of Trussen storage. Trussen keeps only the link. Available on **every plan**.

## Two kinds of Drive

- **My Drive:** your own Google Drive. Only you upload to it.
- **Company Drive:** one Drive for the whole workspace. Owners and admins connect it, and everyone can upload to it.

## Connect

Open **Integrations** and find the **Google Drive** card.

- **Members:** click **Connect** and sign in to Google.
- **Owners and admins:** click **Connect** and choose **For the whole company** or **Just for me**.
- If the Company Drive is already connected, you can still add your own with **Connect my Drive**.
- **Guests** can't open Integrations, but they can upload to the Company Drive if one is connected.

When Google asks, allow Trussen to add files. If you don't, the connection is removed and you need to connect again.

## Who can open the files

Each Drive has a setting for files Trussen uploads: **Company files open for** and **My files open for**.

| Option | Who can open the file |
|---|---|
| Private | Only the person who uploaded it |
| Company emails only | Anyone signed in with your company's Google Workspace email, with the link |
| Public | Anyone with the link |

- **Company emails only** appears only for company Google accounts, not gmail.com.
- Owners and admins can turn off **Public Drive links** for personal Drives in **Settings**.

## Which Drive is used

If you have both, choose under **Upload my files to**: **Company Drive** or **My Drive**.

## Upload a file

On an issue, use **Upload to Drive** in the attachments. Files can be up to **{{drive.uploadMb}} MB**. See *Attachments and files*.

## Disconnect or switch

- **Switch account:** connect a different Google account as your Drive.
- **Disconnect:** you can no longer upload to it. Files already in Drive stay, and their links keep working.
- **Disconnect company Drive** (owners and admins): nobody can upload to it until it's connected again. Files stay.

## Good to know

- If the person who connected the Company Drive leaves or stops being an admin, it's disconnected. Connect a new one, ideally with a shared company account.
- If Google stops accepting the connection, for example after a password change, it's disconnected. Connect again.
