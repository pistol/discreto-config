# discreto-config

Public Tinfoil Container config for Discreto. Clients verify the running enclave
against the signed releases of this repo, so it must stay public. It holds no
code and no secret values: only the image digest, network allowlists, the names
of the secrets, and the web app in `docs/` (served by GitHub Pages at
https://pistol.github.io/discreto-config/).

Written by `scripts/new_config_repo.py` in the Discreto code repo. Don't edit
`tinfoil-config.yml` or `docs/` by hand; change the code repo and re-run the script.

To release: Actions, Tinfoil Release, with a new version such as v0.0.2.
