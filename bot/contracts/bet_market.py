# v0.2.0
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

#
# BetMarket — peer-to-peer YES/NO betting on real-world events.
# - Anyone can create_bet by staking GEN with a YES/NO claim and a deadline.
# - Anyone else can accept_bet by matching the stake (taking the opposite side).
# - After the deadline, anyone can resolve(). The contract fetches web evidence
#   and asks a single on-chain LLM call to decide YES / NO / PENDING / UNCLEAR.
# - Winner gets pot - fee. House gets fee. UNCLEAR refunds both sides.
from genlayer import *
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import quote, unquote
import json


ZERO_ADDR = Address("0x0000000000000000000000000000000000000000")


@gl.evm.contract_interface
class NativeRecipient:
    class View:
        pass

    class Write:
        pass


@allow_storage
@dataclass
class Bet:
    bet_id: u256
    creator: Address
    accepter: Address
    creator_yes: bool                 # True if creator bet YES on the claim
    question: str                     # the YES/NO claim, e.g. "Lakers beat Bulls on 2026-04-30"
    resolution_url: str               # optional URL the resolver should consult; "" = web search
    stake: u256                       # amount each side staked, in wei
    deadline: u256                    # unix timestamp; resolve() callable after this
    status: str                       # "open" | "active" | "resolved" | "cancelled"
    outcome: str                      # "" | "YES" | "NO" | "PENDING" | "UNCLEAR"
    winner: Address                   # zero addr if UNCLEAR / unresolved
    created_at: u256
    chat_id: str                      # telegram chat the bet was placed in (display only)
    creator_handle: str               # display handle for nicer UI
    accepter_handle: str
    reasoning: str                    # short explanation from the LLM at resolve time


class BetMarket(gl.Contract):
    house: Address
    fee_bps: u256                     # 10000 == 100%; default 1000 == 10%
    next_id: u256
    bets: TreeMap[u256, Bet]
    open_ids: DynArray[u256]
    active_ids: DynArray[u256]
    resolved_ids: DynArray[u256]
    cancel_requests: TreeMap[u256, Address]
    # Per-address tallies (for /leaderboard)
    wins: TreeMap[Address, u256]
    losses: TreeMap[Address, u256]
    profit_wei: TreeMap[Address, u256]   # cumulative net winnings in wei
    handles: TreeMap[Address, str]       # last seen handle per address

    def __init__(self, house_addr: str, fee_bps: int):
        self.house = Address(house_addr)
        self.fee_bps = u256(fee_bps)
        self.next_id = u256(1)

    # ---------------- Mutations ----------------

    @gl.public.write.payable
    def create_bet(
        self,
        question: str,
        deadline: int,
        creator_yes: bool,
        resolution_url: str,
        chat_id: str,
        creator_handle: str,
    ) -> int:
        amount = gl.message.value
        assert amount > u256(0), "Must stake > 0 GEN"
        assert u256(deadline) > int(datetime.now().timestamp()), "Deadline must be in the future"
        assert len(question) > 0 and len(question) < 500, "Question length out of range"

        bet_id = self.next_id
        self.next_id = self.next_id + u256(1)

        bet = Bet(
            bet_id=bet_id,
            creator=gl.message.sender_address,
            accepter=ZERO_ADDR,
            creator_yes=creator_yes,
            question=question,
            resolution_url=resolution_url,
            stake=amount,
            deadline=u256(deadline),
            status="open",
            outcome="",
            winner=ZERO_ADDR,
            created_at=int(datetime.now().timestamp()),
            chat_id=chat_id,
            creator_handle=creator_handle,
            accepter_handle="",
            reasoning="",
        )
        self.bets[bet_id] = bet
        self.open_ids.append(bet_id)
        self.handles[gl.message.sender_address] = creator_handle
        return int(bet_id)

    @gl.public.write.payable
    def accept_bet(self, bet_id: int, accepter_handle: str) -> None:
        bid = u256(bet_id)
        assert bid in self.bets, "No such bet"
        bet = self.bets[bid]
        assert bet.status == "open", "Bet is not open"
        assert gl.message.sender_address != bet.creator, "Cannot accept your own bet"
        assert gl.message.value == bet.stake, "Must match stake exactly"
        assert int(datetime.now().timestamp()) < bet.deadline, "Bet expired"

        bet.accepter = gl.message.sender_address
        bet.accepter_handle = accepter_handle
        bet.status = "active"
        self.bets[bid] = bet

        self._remove_id(self.open_ids, bid)
        self.active_ids.append(bid)
        self.handles[gl.message.sender_address] = accepter_handle

    @gl.public.write
    def cancel_bet(self, bet_id: int) -> None:
        bid = u256(bet_id)
        assert bid in self.bets, "No such bet"
        bet = self.bets[bid]
        assert bet.status == "open", "Already accepted or resolved"
        assert gl.message.sender_address == bet.creator, "Only creator may cancel"

        bet.status = "cancelled"
        self.bets[bid] = bet
        self._remove_id(self.open_ids, bid)
        self._send_gen(bet.creator, bet.stake)

    @gl.public.write
    def request_cancel_active(self, bet_id: int) -> None:
        bid = u256(bet_id)
        assert bid in self.bets, "No such bet"
        bet = self.bets[bid]
        assert bet.status == "active", "Bet is not active"
        sender = gl.message.sender_address
        assert sender == bet.creator or sender == bet.accepter, "Only bettors may request cancellation"

        if bid not in self.cancel_requests:
            self.cancel_requests[bid] = sender
            return

        requester = self.cancel_requests[bid]
        if requester == sender:
            return

        bet.status = "cancelled"
        bet.outcome = "CANCELLED"
        bet.winner = ZERO_ADDR
        bet.reasoning = "Both bettors agreed to cancel and refund before resolution."
        self.bets[bid] = bet
        self._remove_id(self.active_ids, bid)
        self._send_gen(bet.creator, bet.stake)
        self._send_gen(bet.accepter, bet.stake)

    @gl.public.write
    def resolve(self, bet_id: int) -> None:
        bid = u256(bet_id)
        assert bid in self.bets, "No such bet"
        bet = self.bets[bid]
        assert bet.status == "active", "Bet is not active"
        assert int(datetime.now().timestamp()) >= bet.deadline, "Too early to resolve"

        question = bet.question
        url = bet.resolution_url

        result = self._resolve_claim(question, url, int(bet.deadline))
        outcome = result["verdict"]
        reasoning = result["reasoning"]

        bet.outcome = outcome
        bet.reasoning = reasoning

        if outcome == "PENDING":
            # Evidence says the event is not final yet. Keep both stakes locked
            # and let anyone call resolve() again later.
            bet.status = "active"
            self.bets[bid] = bet
            return

        if outcome == "UNCLEAR":
            # Refund both sides; no fee, no winner.
            bet.status = "resolved"
            bet.winner = ZERO_ADDR
            self.bets[bid] = bet
            self._remove_id(self.active_ids, bid)
            self.resolved_ids.append(bid)
            self._send_gen(bet.creator, bet.stake)
            self._send_gen(bet.accepter, bet.stake)
            return

        creator_won = (outcome == "YES" and bet.creator_yes) or (
            outcome == "NO" and not bet.creator_yes
        )
        winner = bet.creator if creator_won else bet.accepter
        loser = bet.accepter if creator_won else bet.creator

        bet.status = "resolved"
        bet.winner = winner
        self.bets[bid] = bet
        self._remove_id(self.active_ids, bid)
        self.resolved_ids.append(bid)

        pot = bet.stake + bet.stake
        fee = (pot * self.fee_bps) // u256(10000)
        winner_amount = pot - fee

        self._send_gen(winner, winner_amount)
        if fee > u256(0):
            self._send_gen(self.house, fee)

        self.wins[winner] = self.wins.get(winner, u256(0)) + u256(1)
        self.losses[loser] = self.losses.get(loser, u256(0)) + u256(1)
        gained = winner_amount - bet.stake
        self.profit_wei[winner] = self.profit_wei.get(winner, u256(0)) + gained

    # ---------------- Views ----------------

    @gl.public.view
    def get_bet(self, bet_id: int) -> dict:
        bid = u256(bet_id)
        if bid not in self.bets:
            return {}
        return self._bet_to_dict(self.bets[bid])

    @gl.public.view
    def list_bets(self, status: str, limit: int) -> list:
        if status == "open":
            ids = self.open_ids
        elif status == "active":
            ids = self.active_ids
        elif status == "resolved":
            ids = self.resolved_ids
        else:
            return []
        out = []
        n = len(ids)
        # Most recent first
        i = n - 1
        count = 0
        while i >= 0 and count < limit:
            out.append(self._bet_to_dict(self.bets[ids[i]]))
            i -= 1
            count += 1
        return out

    @gl.public.view
    def my_bets(self, addr: str, limit: int) -> list:
        target = Address(addr)
        out = []
        # Walk all bets newest-first up to limit hits
        i = int(self.next_id) - 1
        while i >= 1 and len(out) < limit:
            bid = u256(i)
            if bid in self.bets:
                b = self.bets[bid]
                if b.creator == target or b.accepter == target:
                    out.append(self._bet_to_dict(b))
            i -= 1
        return out

    @gl.public.view
    def leaderboard(self, limit: int) -> list:
        rows = []
        for addr in self.profit_wei:
            rows.append({
                "address": str(addr),
                "handle": self.handles.get(addr, ""),
                "wins": int(self.wins.get(addr, u256(0))),
                "losses": int(self.losses.get(addr, u256(0))),
                "profit_wei": str(self.profit_wei.get(addr, u256(0))),
            })
        rows.sort(key=lambda r: int(r["profit_wei"]), reverse=True)
        return rows[:limit]

    @gl.public.view
    def stats(self) -> dict:
        return {
            "total_bets": int(self.next_id) - 1,
            "open": len(self.open_ids),
            "active": len(self.active_ids),
            "resolved": len(self.resolved_ids),
            "house": str(self.house),
            "fee_bps": int(self.fee_bps),
        }

    # ---------------- Internals ----------------

    def _remove_id(self, arr: DynArray[u256], value: u256) -> None:
        n = len(arr)
        for i in range(n):
            if arr[i] == value:
                arr[i] = arr[n - 1]
                arr.pop()
                return

    def _send_gen(self, recipient: Address, amount: u256) -> None:
        # Native GEN payouts to user wallets must be emitted as EVM-layer
        # transfers. ContractAt is for Intelligent Contract messages.
        NativeRecipient(recipient).emit_transfer(value=amount)

    def _bet_to_dict(self, b: Bet) -> dict:
        return {
            "id": int(b.bet_id),
            "creator": str(b.creator),
            "creator_handle": b.creator_handle,
            "accepter": str(b.accepter),
            "accepter_handle": b.accepter_handle,
            "creator_yes": b.creator_yes,
            "question": b.question,
            "resolution_url": b.resolution_url,
            "stake": str(b.stake),
            "deadline": int(b.deadline),
            "status": b.status,
            "outcome": b.outcome,
            "winner": str(b.winner),
            "created_at": int(b.created_at),
            "chat_id": b.chat_id,
            "reasoning": b.reasoning,
            "cancel_requested_by": str(self.cancel_requests.get(b.bet_id, ZERO_ADDR)),
        }

    def _resolve_claim(self, question: str, url: str, deadline: int) -> dict:
        if url.startswith("crypto:"):
            return self._resolve_crypto_price(url)
        if url.startswith("sports:"):
            return self._resolve_sports_event(url)
        if url.startswith("news:"):
            return self._resolve_news_claim(question, url, deadline)

        # Keep validator agreement focused on the verdict only. Free-form
        # reasoning differs too often across validators and causes false
        # consensus failures.
        def nondet_verdict() -> str:
            evidence = ""
            if len(url) > 0 and url.startswith("http"):
                try:
                    evidence = gl.nondet.web.render(url, mode="text")[:6000]
                except Exception:
                    evidence = ""
            if len(evidence) == 0:
                try:
                    search = "https://duckduckgo.com/html/?q=" + quote(question)
                    evidence = gl.nondet.web.render(search, mode="text")[:6000]
                except Exception:
                    evidence = ""

            prompt = self._build_prompt(question, url, evidence)
            try:
                res = gl.nondet.exec_prompt(prompt, response_format="json")
            except Exception:
                try:
                    res = gl.nondet.exec_prompt(prompt)
                except Exception:
                    return "UNCLEAR"

            if isinstance(res, str):
                try:
                    data = json.loads(res)
                except Exception:
                    return "UNCLEAR"
            else:
                data = res

            verdict = str(data.get("verdict", "UNCLEAR")).strip().upper()
            if verdict not in ("YES", "NO", "UNCLEAR"):
                return "UNCLEAR"

            confidence_raw = data.get("confidence", 0)
            try:
                confidence = float(confidence_raw)
            except Exception:
                confidence = 0.0

            if verdict != "UNCLEAR" and confidence < 0.55:
                return "UNCLEAR"
            return verdict

        try:
            verdict = gl.eq_principle.prompt_comparative(
                nondet_verdict,
                principle=(
                    "Both answers must indicate the same final verdict. "
                    "YES/TRUE are equivalent, NO/FALSE are equivalent, and "
                    "UNCLEAR/UNKNOWN/INSUFFICIENT_EVIDENCE are equivalent. "
                    "Different final outcomes are not equivalent."
                ),
            )
        except Exception:
            verdict = "UNCLEAR"

        outcome = str(verdict).strip().upper()
        if outcome not in ("YES", "NO", "UNCLEAR"):
            outcome = "UNCLEAR"

        if outcome == "YES":
            reason = "Validators agreed the claim resolved YES from available web evidence."
        elif outcome == "NO":
            reason = "Validators agreed the claim resolved NO from available web evidence."
        else:
            reason = "Validators could not reach a confident YES or NO verdict."

        return {"verdict": outcome, "reasoning": reason}

    def _resolve_crypto_price(self, spec: str) -> dict:
        parts = spec.split(":")
        if len(parts) != 7 or parts[1] != "coinbase":
            return {
                "verdict": "UNCLEAR",
                "reasoning": "Crypto price resolver was not configured correctly.",
            }

        product = parts[2]
        comparator = parts[3]
        target_text = parts[4]
        start_text = parts[5]
        end_text = parts[6]

        try:
            target = float(target_text)
            start_ts = int(start_text)
            end_ts = int(end_text)
        except Exception:
            return {
                "verdict": "UNCLEAR",
                "reasoning": "Crypto price resolver inputs were invalid.",
            }

        def nondet_crypto_verdict() -> str:
            try:
                start_iso = quote(datetime.utcfromtimestamp(start_ts).isoformat() + "Z")
                end_iso = quote(datetime.utcfromtimestamp(end_ts).isoformat() + "Z")
                api_url = (
                    f"https://api.exchange.coinbase.com/products/{product}/candles"
                    f"?granularity=60&start={start_iso}&end={end_iso}"
                )
                raw = gl.nondet.web.render(api_url, mode="text")[:12000]
                first = raw.find("[")
                last = raw.rfind("]")
                if first < 0 or last <= first:
                    return "UNCLEAR"
                candles = json.loads(raw[first : last + 1])
            except Exception:
                return "UNCLEAR"

            if not isinstance(candles, list) or len(candles) == 0:
                return "UNCLEAR"

            high = 0.0
            low = 1000000000000.0
            seen = False
            for candle in candles:
                try:
                    # Coinbase candles: [time, low, high, open, close, volume]
                    candle_low = float(candle[1])
                    candle_high = float(candle[2])
                except Exception:
                    continue
                if candle_high > high:
                    high = candle_high
                if candle_low < low:
                    low = candle_low
                seen = True

            if not seen:
                return "UNCLEAR"
            if comparator == "GTE":
                return "YES" if high >= target else "NO"
            if comparator == "LTE":
                return "YES" if low <= target else "NO"
            return "UNCLEAR"

        try:
            verdict = gl.eq_principle.prompt_comparative(
                nondet_crypto_verdict,
                principle=(
                    "Both answers must indicate the same crypto price result. "
                    "YES/TRUE are equivalent, NO/FALSE are equivalent, and "
                    "UNCLEAR/UNKNOWN/INSUFFICIENT_EVIDENCE are equivalent."
                ),
            )
        except Exception:
            verdict = "UNCLEAR"

        outcome = str(verdict).strip().upper()
        if outcome not in ("YES", "NO", "UNCLEAR"):
            outcome = "UNCLEAR"

        direction = "at or above" if comparator == "GTE" else "at or below"
        if outcome == "UNCLEAR":
            reason = f"Could not verify {product} price data from Coinbase for the bet window."
        else:
            reason = f"Coinbase candles show {product} was {direction} {target_text}: {outcome}."

        return {"verdict": outcome, "reasoning": reason}

    def _decode_part(self, value: str) -> str:
        try:
            return unquote(value)
        except Exception:
            return value

    def _fetch_web_evidence(self, query: str, source_hint: str) -> str:
        evidence = ""
        if len(source_hint) > 0 and source_hint.startswith("http"):
            try:
                evidence = gl.nondet.web.render(source_hint, mode="text")[:5000]
            except Exception:
                evidence = ""

        try:
            search = "https://duckduckgo.com/html/?q=" + quote(query)
            search_text = gl.nondet.web.render(search, mode="text")[:5000]
            if len(evidence) > 0:
                evidence = evidence + "\n\nSEARCH RESULTS:\n" + search_text
            else:
                evidence = search_text
        except Exception:
            pass

        return evidence[:9000]

    def _resolve_sports_event(self, spec: str) -> dict:
        parts = spec.split(":")
        if len(parts) < 9 or parts[1] != "web" or parts[2] != "v1":
            return {
                "verdict": "UNCLEAR",
                "reasoning": "Sports resolver was not configured correctly.",
            }

        market = self._decode_part(parts[4])
        selection = self._decode_part(parts[5])
        event_name = self._decode_part(parts[6])
        rule = self._decode_part(parts[7])
        source_hint = self._decode_part(parts[8])

        def nondet_sports_verdict() -> str:
            evidence = self._fetch_web_evidence(
                event_name + " final score result " + selection,
                source_hint,
            )
            if len(evidence) == 0:
                return "PENDING"

            prompt = (
                "You are resolving a GenLayer YES/NO sports bet.\n"
                "Resolve only from reliable event/result evidence.\n"
                "Return PENDING if the event is not started, live, in extra time, in penalties, delayed, postponed, abandoned without a final official result, or the result is not posted yet.\n"
                "Return YES only if the final result satisfies the selected YES side.\n"
                "Return NO only if the final result is available and does not satisfy the selected YES side.\n"
                "Return UNCLEAR if the evidence is contradictory or too weak.\n"
                "Respond ONLY with JSON in this shape:\n"
                '{"state":"FINAL|PENDING|UNCLEAR","verdict":"YES|NO|PENDING|UNCLEAR","confidence":0.0,"reasoning":"short reason"}'
                "\n\nEVENT: " + event_name +
                "\nMARKET: " + market +
                "\nYES SELECTION: " + selection +
                "\nSETTLEMENT RULE: " + rule +
                "\n\nEVIDENCE:\n" + evidence
            )
            try:
                res = gl.nondet.exec_prompt(prompt, response_format="json")
            except Exception:
                try:
                    res = gl.nondet.exec_prompt(prompt)
                except Exception:
                    return "PENDING"

            if isinstance(res, str):
                try:
                    data = json.loads(res)
                except Exception:
                    return "UNCLEAR"
            else:
                data = res

            state = str(data.get("state", "")).strip().upper()
            verdict = str(data.get("verdict", "UNCLEAR")).strip().upper()

            if state == "PENDING" or verdict == "PENDING":
                return "PENDING"
            if state == "UNCLEAR":
                return "UNCLEAR"

            confidence_raw = data.get("confidence", 0)
            try:
                confidence = float(confidence_raw)
            except Exception:
                confidence = 0.0

            if verdict in ("YES", "NO") and confidence >= 0.60:
                return verdict
            return "UNCLEAR"

        try:
            verdict = gl.eq_principle.prompt_comparative(
                nondet_sports_verdict,
                principle=(
                    "Both answers must indicate the same sports settlement state. "
                    "YES/TRUE are equivalent, NO/FALSE are equivalent, "
                    "PENDING/LIVE/NOT_FINAL/POSTPONED are equivalent, and "
                    "UNCLEAR/UNKNOWN/INSUFFICIENT_EVIDENCE are equivalent."
                ),
            )
        except Exception:
            verdict = "UNCLEAR"

        outcome = str(verdict).strip().upper()
        if outcome not in ("YES", "NO", "PENDING", "UNCLEAR"):
            outcome = "UNCLEAR"

        if outcome == "PENDING":
            reason = "Sports result is not final yet. Retry resolve after the official result is posted."
        elif outcome == "UNCLEAR":
            reason = "Validators could not verify a reliable final sports result."
        else:
            reason = f"Validators resolved the sports result as {outcome} for selection: {selection}."

        return {"verdict": outcome, "reasoning": reason}

    def _resolve_news_claim(self, question: str, spec: str, deadline: int) -> dict:
        parts = spec.split(":")
        if len(parts) < 7 or parts[1] != "web" or parts[2] != "v1":
            return {
                "verdict": "UNCLEAR",
                "reasoning": "News resolver was not configured correctly.",
            }

        try:
            claim_deadline = int(parts[3])
        except Exception:
            claim_deadline = deadline

        claim = self._decode_part(parts[4])
        rule = self._decode_part(parts[5])
        source_hint = self._decode_part(parts[6])

        # Give fast-moving news a short publication/indexing buffer so a bet
        # does not refund or settle from stale search results right at cutoff.
        now_ts = int(datetime.now().timestamp())
        if now_ts < claim_deadline + 1800:
            return {
                "verdict": "PENDING",
                "reasoning": "News deadline passed recently. Retry after a short source-update buffer.",
            }

        def nondet_news_verdict() -> str:
            evidence = self._fetch_web_evidence(
                claim + " confirmed before " + datetime.utcfromtimestamp(claim_deadline).isoformat() + "Z",
                source_hint,
            )
            if len(evidence) == 0:
                return "UNCLEAR"

            prompt = (
                "You are resolving a GenLayer YES/NO public-fact bet from news or official evidence.\n"
                "Return YES only if reliable sources confirm the claim happened by the deadline.\n"
                "Return NO only if the deadline passed and reliable evidence shows the claim did not happen by then.\n"
                "Return PENDING only if official resolution is still not available or the situation is explicitly still developing.\n"
                "Return UNCLEAR if evidence is contradictory, weak, or not enough to settle fairly.\n"
                "Respond ONLY with JSON in this shape:\n"
                '{"state":"FINAL|PENDING|UNCLEAR","verdict":"YES|NO|PENDING|UNCLEAR","confidence":0.0,"reasoning":"short reason"}'
                "\n\nCLAIM: " + claim +
                "\nDEADLINE UTC: " + datetime.utcfromtimestamp(claim_deadline).isoformat() + "Z" +
                "\nSETTLEMENT RULE: " + rule +
                "\n\nEVIDENCE:\n" + evidence
            )
            try:
                res = gl.nondet.exec_prompt(prompt, response_format="json")
            except Exception:
                try:
                    res = gl.nondet.exec_prompt(prompt)
                except Exception:
                    return "UNCLEAR"

            if isinstance(res, str):
                try:
                    data = json.loads(res)
                except Exception:
                    return "UNCLEAR"
            else:
                data = res

            state = str(data.get("state", "")).strip().upper()
            verdict = str(data.get("verdict", "UNCLEAR")).strip().upper()

            if state == "PENDING" or verdict == "PENDING":
                return "PENDING"
            if state == "UNCLEAR":
                return "UNCLEAR"

            confidence_raw = data.get("confidence", 0)
            try:
                confidence = float(confidence_raw)
            except Exception:
                confidence = 0.0

            if verdict in ("YES", "NO") and confidence >= 0.60:
                return verdict
            return "UNCLEAR"

        try:
            verdict = gl.eq_principle.prompt_comparative(
                nondet_news_verdict,
                principle=(
                    "Both answers must indicate the same public-fact settlement state. "
                    "YES/TRUE are equivalent, NO/FALSE are equivalent, "
                    "PENDING/NOT_READY/STILL_DEVELOPING are equivalent, and "
                    "UNCLEAR/UNKNOWN/INSUFFICIENT_EVIDENCE are equivalent."
                ),
            )
        except Exception:
            verdict = "UNCLEAR"

        outcome = str(verdict).strip().upper()
        if outcome not in ("YES", "NO", "PENDING", "UNCLEAR"):
            outcome = "UNCLEAR"

        if outcome == "PENDING":
            reason = "Reliable news resolution is not ready yet. Retry resolve later."
        elif outcome == "UNCLEAR":
            reason = "Validators could not reach a reliable news verdict."
        else:
            reason = f"Validators resolved the public-fact claim as {outcome}."

        return {"verdict": outcome, "reasoning": reason}

    def _build_prompt(self, question: str, url: str, evidence: str) -> str:
        hint = ""
        if len(url) > 0:
            hint = f"\nThe creator suggested this source: {url}"
        return (
            "You are an impartial bet adjudicator on the GenLayer network.\n"
            "You will be given a YES/NO claim and web evidence.\n"
            "Decide whether the claim is TRUE (YES), FALSE (NO), or you don't have enough\n"
            "reliable evidence to tell (UNCLEAR).\n"
            "Use a single best verdict. If the evidence is weak, contradictory, or absent, return UNCLEAR.\n"
            "Return a confidence between 0 and 1.\n"
            "Respond ONLY with JSON, no markdown, in this exact shape:\n"
            '{"verdict": "YES" | "NO" | "UNCLEAR", "confidence": 0.0, "reasoning": "<one short sentence>"}\n\n'
            f"CLAIM: {question}{hint}\n\n"
            f"EVIDENCE:\n{evidence}"
        )
