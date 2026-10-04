# Security policy

## Supported versions

Security fixes go into the latest released version of the `@surgesim/*` packages.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting instead: open the
repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and the
version you tested.

You can expect an acknowledgement within a few days. Surgesim is maintained by one person, so fix times vary, but a
confirmed vulnerability will be fixed and released before it is described publicly.

## What counts

Surgesim reads model files (JSON, or TypeScript/JavaScript modules) and CloudFormation templates, and writes HTML
reports. Issues that matter include:

- a model or template that makes the CLI read or write files outside the paths you gave it,
- HTML reports that run script from model-supplied text (names, labels and descriptions are escaped; a bypass is a bug),
- a published package that contains something it should not.

Note that TypeScript and JavaScript model files are executed as code, like any build script. Only run model files you
trust. JSON models are data and are not executed.
