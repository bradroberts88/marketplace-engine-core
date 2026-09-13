# Tailscale setup for QConnect cards

Every card joins the tailnet with its own key. The key is single-use, expires in
90 days if it is never redeemed, and carries the tag `tag:qconnect-device`. A
tagged node has no user identity, so a stolen card cannot reach anything the
rules below do not allow.

## 1. Create an API access token

In the Tailscale admin console: **Settings → Keys → Generate access token**.
Give it auth-key write access. Save it in this app as `TAILSCALE_API_KEY`, and
save your tailnet name (for example `example.com` or `tail1234.ts.net`) as
`TAILSCALE_TAILNET`.

## 2. Paste this policy

The tag must exist in the tailnet policy before any key can carry it, otherwise
key creation fails with "tag not permitted". Merge these blocks into your ACL
(**Access controls** in the admin console):

```json
{
  "tagOwners": {
    "tag:qconnect-device": ["autogroup:admin"],
    "tag:qconnect-server": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["tag:qconnect-server", "autogroup:admin"],
      "dst": ["tag:qconnect-device:*"]
    }
  ],
  "ssh": [
    {
      "action": "accept",
      "src": ["autogroup:admin"],
      "dst": ["tag:qconnect-device"],
      "users": ["root", "autogroup:nonroot"]
    }
  ]
}
```

What this gives you:

- the server and your admins can reach any card;
- cards cannot reach each other, so one compromised card is one compromised
  card;
- admin SSH into a card still works for support.

## 3. Flashing

`provision-sd.sh` mints a key per card automatically when `TAILSCALE_API_KEY`
and `TAILSCALE_TAILNET` are present. Pass `--tailscale-key` only if you want to
supply one by hand; the writer still refuses a key it has already used.

At the end of a batch run, `provision-batch.sh --revoke-batch-key <key>` retires
the shared key the run started with, so nothing left over can join later.

## 4. Rotation

Keys carried by cards expire on their own. Rotate the API token itself every
90 days: generate a new one in the console, save it over `TAILSCALE_API_KEY`,
then delete the old token in the console.
