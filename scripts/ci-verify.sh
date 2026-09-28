set -euo pipefail

[[ "$CHECKS_RESULT" == 'success' && -n "$TEST_PACKAGES" ]] || exit 1
if [[ "$TEST_PACKAGES" == '[]' ]]; then
  [[ "$TESTS_RESULT" == 'skipped' ]]
else
  [[ "$TESTS_RESULT" == 'success' ]]
fi
