# discreto-config

Public Tinfoil Container config for Discreto. Clients verify the running
enclave against the signed releases of this repo, so it must stay public.
It holds no code and no secret values: only the image digests, network
allowlists and the names of the secrets.

The release workflows come from tinfoilsh/tinfoil-containers-template.
To release: set the image digests in `tinfoil-config.yml`, then run
`tinfoil repo build run pistol/discreto-config --version vX.Y.Z`
(or Actions, Tinfoil Release).
