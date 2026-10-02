# @surgesim/platform

Interfaces only (`FileStore`, `Logger`, `Clock`): everything environment-specific that the Surgesim engine must not touch
itself, so the engine stays embeddable in Node and in a Web Worker. Hosts such as the CLI supply the implementations.

Part of [Surgesim](https://github.com/NiloyBhattacharjee/surgesim). Apache-2.0.
