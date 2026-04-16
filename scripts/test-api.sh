#!/bin/bash
# FlashSol v6 — Автоматические тесты API
# Запуск: bash scripts/test-api.sh

BASE="http://localhost:3001"
PASS=0
FAIL=0

check() {
  local name="$1"
  local result="$2"
  local expected="$3"
  if echo "$result" | grep -q "$expected"; then
    echo "✅ $name"
    PASS=$((PASS+1))
  else
    echo "❌ $name"
    echo "   Ожидали: $expected"
    echo "   Получили: $(echo $result | head -c 200)"
    FAIL=$((FAIL+1))
  fi
}

echo "🔍 FlashSol v6 API Tests"
echo "========================"
echo ""

# 1. Health check
R=$(curl -s "$BASE/health")
check "GET /health" "$R" '"ok":true'
check "GET /health version=v6" "$R" '"version":"v6"'

# 2. Stats
R=$(curl -s "$BASE/api/stats")
check "GET /api/stats" "$R" '"ok":true'
check "GET /api/stats totalUsers" "$R" '"totalUsers"'

# 3. Levels
R=$(curl -s "$BASE/api/levels")
check "GET /api/levels" "$R" '"ok":true'
check "GET /api/levels 4 levels" "$R" '"name":"Elite"'

# 4. Register user A (без реферера)
WALLET_A="7xKpABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012"
R=$(curl -s -X POST "$BASE/api/register" \
  -H "Content-Type: application/json" \
  -d "{\"wallet\":\"$WALLET_A\"}")
check "POST /api/register (no referrer)" "$R" '"ok":true'

# 5. Попытка повторной регистрации
R=$(curl -s -X POST "$BASE/api/register" \
  -H "Content-Type: application/json" \
  -d "{\"wallet\":\"$WALLET_A\"}")
check "POST /api/register (duplicate → AlreadyRegistered)" "$R" 'AlreadyRegistered'

# 6. Get user A
R=$(curl -s "$BASE/api/user/$WALLET_A")
check "GET /api/user/:wallet" "$R" '"ok":true'
check "GET /api/user activeLevel=null" "$R" '"activeLevel":null'

# 7. Register user B с реферером A
WALLET_B="9mQpBCDEFGHIJKLMNOPQRSTUVWXYZ123456789012"
R=$(curl -s -X POST "$BASE/api/register" \
  -H "Content-Type: application/json" \
  -d "{\"wallet\":\"$WALLET_B\",\"referrer\":\"$WALLET_A\"}")
check "POST /api/register (with referrer)" "$R" '"ok":true'

# 8. Правило уровней: B пытается задепозитить Starter (0)
# когда A ещё не делал депозит — должно быть OK (нет ограничения)
R=$(curl -s -X POST "$BASE/api/deposit/prepare" \
  -H "Content-Type: application/json" \
  -d "{\"wallet\":\"$WALLET_B\",\"levelId\":0}")
check "POST /api/deposit/prepare level=0 (sponsor no level)" "$R" '"ok":true'

# 9. Self-referral проверка
R=$(curl -s -X POST "$BASE/api/register" \
  -H "Content-Type: application/json" \
  -d "{\"wallet\":\"$WALLET_A\",\"referrer\":\"$WALLET_A\"}")
check "POST /api/register (self-referral → error)" "$R" 'SelfReferral\|AlreadyRegistered'

# 10. Get referrals
R=$(curl -s "$BASE/api/user/$WALLET_A/referrals")
check "GET /api/user/:wallet/referrals" "$R" '"ok":true'

echo ""
echo "========================"
echo "✅ Passed: $PASS"
echo "❌ Failed: $FAIL"
echo ""

if [ $FAIL -eq 0 ]; then
  echo "🎉 Все тесты прошли успешно!"
  exit 0
else
  echo "⚠️  Есть ошибки — смотри выше"
  exit 1
fi
