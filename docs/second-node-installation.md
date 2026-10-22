# Second-node installation

Use the current [Evo/Surface installation and onboarding guide](installation-and-onboarding.md).

The previous checkout-based guide is superseded. Do not use the deleted remote-
testing branch, development-only nested `npm ci`, session-derived node configs or
copy Evo's backend-root context to Surface.

The supported flow is: install the same verified release, generate a scoped node
bootstrap bundle on Evo, privately transfer Surface's bundle, join from Surface's
WSL2/systemd distribution, install its node service and plugin, and run doctor.
Its local human operator can enrol/attach without backend-root authority.

No backend reset, source task import, OpenCode upgrade, credential transfer or
physical-machine certification is performed merely by reading this guide.
