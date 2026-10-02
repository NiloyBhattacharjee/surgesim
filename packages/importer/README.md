# @surgesim/importer

Converts a CloudFormation JSON template (what `cdk synth` writes to `cdk.out/*.template.json`) into a Surgesim model.
Supports SQS, Lambda, ECS services, Application Auto Scaling target tracking and API Gateway throttling.

```ts
import { importCloudFormation } from "@surgesim/importer";

const result = importCloudFormation(template, { ratePerSecond: 50 });
if (result.ok) console.log(result.model, result.assumptions, result.warnings);
```

A template says nothing about traffic or how long work takes, so those numbers are assumptions that the result lists
for you to review. Details: [docs/importing.md](https://github.com/NiloyBhattacharjee/surgesim/blob/main/docs/importing.md).

Part of [Surgesim](https://github.com/NiloyBhattacharjee/surgesim). Apache-2.0.
