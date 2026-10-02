"""Print the SDK's SPECS as JSON, for the cross-language drift test."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from surgesim import SPECS  # noqa: E402

print(json.dumps(SPECS))
