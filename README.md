# SnapFrame Premium (private)

Premium add-on for [SnapFrame](https://github.com/angelomagnoBR/snapframe). Requires SnapFrame 2.1.3+.

## Features
- **Speaker highlight**: glowing frame around whoever is speaking; optionally dims everyone else.

## Local testing
1. Download `snapframe-premium.zip` from this repo.
2. Unzip into `Data/modules/snapframe-premium` in your Foundry user data folder.
3. Restart Foundry and enable **SnapFrame Premium** in the world.

## Release (Foundry Premium Content)
1. Set `"protected": true` in `module.json`.
2. Set `"manifest"` to `https://r2.foundryvtt.com/packages-public/snapframe-premium/module.json`.
3. Zip and upload with Foundry's Upload Tool.

Keep `"protected": false` while developing, or the module disappears from your own install.
