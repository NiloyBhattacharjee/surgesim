# @chronon-sim/platform

Interfaces only (`FileStore`, `Logger`, `Clock`): everything environment-specific that the Chronon Sim engine must not touch
itself, so the engine stays embeddable in Node and in a Web Worker. Hosts such as the CLI supply the implementations.

Part of [Chronon Sim](https://github.com/NiloyBhattacharjee/chronon-sim). Apache-2.0.
