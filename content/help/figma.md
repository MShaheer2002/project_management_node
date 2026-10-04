---
id: figma
title: Figma
category: Integrations
route: /integrations
roles: OWNER, ADMIN
plans: STANDARD, PREMIUM
keywords: figma, design, design preview, figma link, figma token, personal access token, figd, thumbnail, prototype
---

See Figma designs right on your issues. Available on **Standard** and **Premium**. Owners and admins connect it.

## Get a Figma token

1. In Figma, open **Settings**, then **Security**.
2. Under **Personal Access Tokens**, click **Generate new token**.
3. Copy it. It starts with `figd_`.

## Connect

1. In Trussen, open **Integrations** and click **Connect** on Figma.
2. Paste the token and save.

Trussen only reads from Figma. It never changes your files.

## Show a design on an issue

Paste a Figma link in the issue's **description**. Links to files, designs, prototypes and boards all work, for example `https://www.figma.com/design/...`.

The issue then shows a design preview. Click **Open in Figma** to open it. If a preview can't load, the card still links to Figma.

Anyone who can see the issue can see its previews. They don't need a Figma account to see the thumbnail.

## Settings

Click **Settings** on the Figma card:

- **Show design thumbnails on issues**
- **Show last modified date**

## Good to know

- The token belongs to the person who connected Figma. Previews only work for files that person can open in Figma.
- If the token expires or is removed in Figma, previews stop. Connect again with a new token.
- **Disconnect** removes design previews from all issues and deletes the stored token.
