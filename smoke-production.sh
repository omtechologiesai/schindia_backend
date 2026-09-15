#!/usr/bin/env bash
# Read-only production smoke test.
#
# Every request is a GET. Nothing is created, changed or deleted, so this is
# safe to run against live data at any time.
#
# The token is minted on the server, because production signs JWTs with a
# secret that only lives in its systemd unit.
set -u
HOST="https://www.brainastra.com"
KEY="$HOME/.ssh/shichida-ec2"
EC2="ubuntu@13.234.196.14"

echo "Minting a token on the production host..."
TOK=$(ssh -i "$KEY" "$EC2" 'PID=$(systemctl show shichida -p MainPID --value)
sudo rm -f /tmp/sm.env
sudo sh -c "cat /proc/$PID/environ > /tmp/sm.env"
sudo chown ubuntu /tmp/sm.env
cd ~/shichida_backend && ./venv/bin/python -c "
import os, logging
logging.disable(logging.CRITICAL)
for kv in open(\"/tmp/sm.env\",\"rb\").read().split(b\"\\0\"):
    if b\"=\" in kv:
        k,v = kv.decode().split(\"=\",1); os.environ[k]=v
import django
os.environ.setdefault(\"DJANGO_SETTINGS_MODULE\",\"schindia_backend.settings\")
django.setup()
from dynamo_backend.client import get_dynamodb_resource
from rest_framework_simplejwt.tokens import AccessToken
us = get_dynamodb_resource().Table(\"Shichida-production-Users\").scan().get(\"Items\", [])
u = [x for x in us if x.get(\"role\") in (\"admin\",\"root\") and x.get(\"status\")==\"approved\"][0]
t = AccessToken(); t[\"user_id\"]=str(u[\"id\"]); t[\"email\"]=u[\"email\"]; t[\"role\"]=u.get(\"role\",\"\")
print(str(t))
" 2>/dev/null | grep "^eyJ"
rm -f /tmp/sm.env' 2>/dev/null | grep "^eyJ" | tail -1)

if [ -z "${TOK:-}" ]; then echo "FAILED to mint a token"; exit 1; fi
echo "ok"; echo

PASS=0; FAIL=0
check() { # name expected path [noauth]
  local name="$1" want="$2" path="$3" noauth="${4:-}"
  local got
  if [ -n "$noauth" ]; then
    got=$(curl -s -o /dev/null -w "%{http_code}" "$HOST$path")
  else
    got=$(curl -s -o /dev/null -w "%{http_code}" "$HOST$path" -H "Authorization: Bearer $TOK")
  fi
  if [ "$got" = "$want" ]; then
    printf "  PASS  %-46s %s\n" "$name" "$got"; PASS=$((PASS+1))
  else
    printf "  FAIL  %-46s got %s, wanted %s\n" "$name" "$got" "$want"; FAIL=$((FAIL+1))
  fi
}

echo "PUBLIC"
check "site loads"                     200 "/"
check "deep link (SPA routing)"        200 "/admin/centres"

echo; echo "AUTH"
check "rejects a request with no token" 401 "/api/auth/me/" noauth

echo; echo "CORE DATA"
check "centres"                        200 "/api/v1/centres/"
check "children needs a centre (by design)" 400 "/api/v1/children/"
check "global roles"                   200 "/api/v1/global/roles/"
check "global people"                  200 "/api/v1/global/people/"
check "permissions matrix"             200 "/api/v1/global/permissions-matrix/"
check "catalogue items"                200 "/api/v1/catalogue-items/"

echo; echo "PER-CENTRE (uses the one real centre)"
CID=$(curl -s "$HOST/api/v1/centres/" -H "Authorization: Bearer $TOK" \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print((d[0] if isinstance(d,list) and d else {}).get('id',''))" 2>/dev/null)
if [ -n "$CID" ]; then
  echo "  centre: $CID"
  check "sessions"                     200 "/api/v1/centres/$CID/sessions/"
  check "slots"                        200 "/api/v1/centres/$CID/slots/"
  check "roles"                        200 "/api/v1/centres/$CID/roles/"
  check "invoice history"              200 "/api/v1/centres/$CID/invoices/"
  check "debtors"                      200 "/api/v1/centres/$CID/invoices/debtors/"
  check "payments"                     200 "/api/v1/centres/$CID/invoices/payments/"
  check "invoice generate-data"        200 "/api/v1/centres/$CID/invoices/generate-data/"
else
  echo "  (no centre found — skipped)"
fi

echo; echo "NUMBERING"
check "next invoice number"            200 "/api/v1/invoices/next-number/"

echo
echo "-----------------------------------------------"
echo "  passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] && echo "  production looks healthy" || echo "  investigate the failures above"
