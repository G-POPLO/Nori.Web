"""`codenames` / Woodland Quest runtime compatible with the shipped reducer."""

from __future__ import annotations

import json
import random
import re
import time
from pathlib import Path
from copy import deepcopy
from typing import Any, Dict, Iterable, List, Optional, Tuple

from ..services.llm_service import LLM_SERVICE

from .base import BaseCartridge, CommandRejected, ReducerResult

TEAM_A = "A"
TEAM_B = "B"
AGENT = "AGENT"
BYSTANDER = "BYSTANDER"
ASSASSIN = "ASSASSIN"
NORMAL = "NORMAL"
SUDDEN_DEATH = "SUDDEN_DEATH"
GAME_OVER = "GAME_OVER"

_WORDS_FILE = Path(__file__).resolve().parents[1] / "data" / "codenames_words.json"
_RAW_WORDS = json.loads(_WORDS_FILE.read_text(encoding="utf-8"))
if isinstance(_RAW_WORDS, dict):
    WORDS_BY_LOCALE: Dict[str, List[str]] = _RAW_WORDS
else:
    WORDS_BY_LOCALE: Dict[str, List[str]] = {"en": _RAW_WORDS}


class CodenamesCartridge(BaseCartridge):
    def __init__(self) -> None:
        super().__init__(
            "codenames",
            {
                "gameState": None,
                "counterpartSide": TEAM_A,
                "agentSide": TEAM_B,
                "settings": {"tokens": 9, "wordLocale": "zh-CN"},
                "tutorial": None,
            },
        )

    @staticmethod
    def _resolve_words(word_locale: Optional[str]) -> List[str]:
        """Resolve localized vocabulary for Codenames game board."""
        if not word_locale:
            return WORDS_BY_LOCALE.get("zh-CN") or WORDS_BY_LOCALE.get("en", [])
        loc = word_locale.lower().replace("_", "-")
        if loc.startswith("zh") or loc in {"cn", "zh-cn", "zh-tw", "zh-hk"}:
            return WORDS_BY_LOCALE.get("zh-CN") or WORDS_BY_LOCALE.get("en", [])
        if loc.startswith("ja") or loc in {"jp", "ja"}:
            return WORDS_BY_LOCALE.get("ja") or WORDS_BY_LOCALE.get("en", [])
        return WORDS_BY_LOCALE.get("en") or list(WORDS_BY_LOCALE.values())[0]

    @staticmethod
    def _other(side: str) -> str:
        return TEAM_B if side == TEAM_A else TEAM_A

    @staticmethod
    def _actor_side(state: Dict[str, Any], actor: str) -> str:
        if actor == "player":
            return state["counterpartSide"]
        if actor == "agent":
            return state["agentSide"]
        raise CommandRejected("Unknown actor")

    @staticmethod
    def _remaining_agents(game: Dict[str, Any], side: str) -> int:
        return sum(
            1
            for index, role in enumerate(game["key"][side])
            if role == AGENT and game["cells"][index]["solvedBy"] is None
        )

    @classmethod
    def _all_agents_solved(cls, game: Dict[str, Any]) -> bool:
        for index in range(25):
            if (
                game["key"][TEAM_A][index] == AGENT
                or game["key"][TEAM_B][index] == AGENT
            ) and game["cells"][index]["solvedBy"] is None:
                return False
        return True

    @staticmethod
    def _generate_keys(rng: random.Random) -> Dict[str, List[str]]:
        a = [BYSTANDER] * 25
        b = [BYSTANDER] * 25
        indexes = list(range(25))
        rng.shuffle(indexes)
        cursor = 0
        for _ in range(3):
            index = indexes[cursor]
            cursor += 1
            a[index] = b[index] = AGENT
        index = indexes[cursor]
        cursor += 1
        a[index] = b[index] = ASSASSIN
        index = indexes[cursor]
        cursor += 1
        a[index] = AGENT
        b[index] = ASSASSIN
        index = indexes[cursor]
        cursor += 1
        a[index] = ASSASSIN
        b[index] = AGENT
        for _ in range(5):
            a[indexes[cursor]] = AGENT
            cursor += 1
        for _ in range(5):
            b[indexes[cursor]] = AGENT
            cursor += 1
        a[indexes[cursor]] = ASSASSIN
        cursor += 1
        b[indexes[cursor]] = ASSASSIN
        return {TEAM_A: a, TEAM_B: b}

    @classmethod
    def _new_game(cls, settings: Dict[str, Any]) -> Dict[str, Any]:
        seed = settings.get("seed")
        if isinstance(seed, bool) or not isinstance(seed, int):
            seed = int(time.time() * 1000)
        rng = random.Random(seed)
        words_pool = cls._resolve_words(settings.get("wordLocale"))
        selected = rng.sample(words_pool, 25)
        return {
            "board": [{"id": word, "text": word} for word in selected],
            "key": cls._generate_keys(rng),
            "cells": [
                {"solvedBy": None, "bystanderMarks": [None, None], "assassinatedBy": None}
                for _ in range(25)
            ],
            "tokensRemaining": settings["tokens"],
            "whoseTurnToGive": TEAM_A,
            "phase": NORMAL,
            "winner": None,
            "history": [],
        }

    @staticmethod
    def _validate_settings(raw: Any, previous: Dict[str, Any]) -> Dict[str, Any]:
        settings = deepcopy(previous)
        if raw is None:
            return settings
        if not isinstance(raw, dict):
            raise CommandRejected("settings must be an object")
        if "tokens" in raw:
            tokens = raw["tokens"]
            if isinstance(tokens, bool) or tokens not in {9, 10, 11}:
                raise CommandRejected("tokens must be 9, 10, or 11")
            settings["tokens"] = tokens
        if "seed" in raw:
            seed = raw["seed"]
            if isinstance(seed, bool) or not isinstance(seed, int):
                raise CommandRejected("seed must be an integer")
            settings["seed"] = seed
        if "wordLocale" in raw:
            if not isinstance(raw["wordLocale"], str):
                raise CommandRejected("wordLocale must be a string")
            settings["wordLocale"] = raw["wordLocale"]
        return settings

    @staticmethod
    def _validate_clue(game: Dict[str, Any], clue: Any) -> Dict[str, Any]:
        if not isinstance(clue, dict):
            raise CommandRejected("clue must be an object")
        word = clue.get("word")
        count = clue.get("count")
        if not isinstance(word, str):
            raise CommandRejected("clue.word must be a string")
        word = word.strip().upper()
        if not word or len(word) > 24 or re.search(r"\s|\d", word):
            raise CommandRejected("Invalid clue word")
        if word in {entry["text"].upper() for entry in game["board"]}:
            raise CommandRejected("Clue word cannot be on the board")
        if count != "infinity" and (isinstance(count, bool) or not isinstance(count, int) or count < 0):
            raise CommandRejected("Clue count must be a non-negative integer or infinity")
        return {"word": word, "count": count}

    @classmethod
    def _finish_turn(cls, game: Dict[str, Any]) -> Dict[str, Any]:
        if game["tokensRemaining"] == 0 and not cls._all_agents_solved(game):
            game["phase"] = SUDDEN_DEATH
            return game
        giver = game["whoseTurnToGive"]
        other = cls._other(giver)
        if cls._remaining_agents(game, other) > 0:
            game["whoseTurnToGive"] = other
        elif cls._remaining_agents(game, giver) > 0:
            game["whoseTurnToGive"] = giver
        else:
            game["phase"] = SUDDEN_DEATH
        return game

    @classmethod
    def _submit_clue(cls, game: Dict[str, Any], side: str, clue: Dict[str, Any]) -> Dict[str, Any]:
        if game["phase"] != NORMAL:
            raise CommandRejected("Can only submit clues during NORMAL phase")
        if game["whoseTurnToGive"] != side:
            raise CommandRejected("Not your turn")
        if cls._remaining_agents(game, side) <= 0:
            raise CommandRejected("This side cannot give clues")
        if game["history"] and game["history"][-1]["endedBy"] is None:
            raise CommandRejected("The current turn is still in progress")
        turn = {"clueGiver": side, "clue": clue, "guesses": [], "endedBy": None}
        game["history"].append(turn)
        return game

    @classmethod
    def _submit_guess(cls, game: Dict[str, Any], side: str, cell_index: int) -> Tuple[Dict[str, Any], str, bool]:
        if game["phase"] not in {NORMAL, SUDDEN_DEATH}:
            raise CommandRejected("Game is over")
        if cell_index < 0 or cell_index >= 25:
            raise CommandRejected("Cell index must be between 0 and 24")
        cell = game["cells"][cell_index]
        if cell["solvedBy"] is not None or cell["assassinatedBy"] is not None:
            raise CommandRejected("Cannot guess an already solved card")

        if game["phase"] == SUDDEN_DEATH:
            if cls._remaining_agents(game, side) <= 0:
                raise CommandRejected("This side cannot guess in sudden death")
            role = game["key"][cls._other(side)][cell_index]
            if role == ASSASSIN:
                cell["assassinatedBy"] = side
                game["phase"] = GAME_OVER
                game["winner"] = None
                return game, "assassin", True
            if role == BYSTANDER:
                marks = cell["bystanderMarks"]
                if marks[0] is None:
                    marks[0] = side
                else:
                    marks[1] = side
                game["phase"] = GAME_OVER
                game["winner"] = None
                return game, "bystander", True
            cell["solvedBy"] = side
            if cls._all_agents_solved(game):
                game["phase"] = GAME_OVER
                game["winner"] = "TEAM"
                return game, "agent", True
            return game, "agent", False

        if not game["history"]:
            raise CommandRejected("No clue has been given")
        turn = game["history"][-1]
        if turn["endedBy"] is not None:
            raise CommandRejected("Current turn has ended")
        if side == turn["clueGiver"]:
            raise CommandRejected("Clue giver cannot make guesses")

        role = game["key"][turn["clueGiver"]][cell_index]
        turn["guesses"].append({"cell": cell_index, "result": role, "at": int(time.time() * 1000)})
        if role == ASSASSIN:
            cell["assassinatedBy"] = side
            game["phase"] = GAME_OVER
            game["winner"] = None
            return game, "assassin", True
        if role == AGENT:
            cell["solvedBy"] = side
            if cls._all_agents_solved(game):
                game["phase"] = GAME_OVER
                game["winner"] = "TEAM"
                return game, "agent", True
            if cls._remaining_agents(game, turn["clueGiver"]) == 0:
                turn["endedBy"] = "ALL_FOUND"
                game["tokensRemaining"] = max(0, game["tokensRemaining"] - 1)
                cls._finish_turn(game)
                return game, "agent", True
            return game, "agent", False
        marks = cell["bystanderMarks"]
        if marks[0] is None:
            marks[0] = side
        else:
            marks[1] = side
        turn["endedBy"] = "BYSTANDER"
        game["tokensRemaining"] = max(0, game["tokensRemaining"] - 1)
        cls._finish_turn(game)
        return game, "bystander", True

    @classmethod
    def _end_turn(cls, game: Dict[str, Any], side: str) -> Tuple[Dict[str, Any], bool]:
        if game["phase"] != NORMAL:
            raise CommandRejected("Can only end turns during NORMAL phase")
        if not game["history"]:
            raise CommandRejected("No turn to end")
        turn = game["history"][-1]
        if turn["endedBy"] is not None:
            raise CommandRejected("Current turn has already ended")
        if side == turn["clueGiver"]:
            raise CommandRejected("Clue giver cannot end turn")
        if not turn["guesses"]:
            raise CommandRejected("Must make at least one guess before ending turn")
        turn["endedBy"] = "VOLUNTARY_END"
        game["tokensRemaining"] = max(0, game["tokensRemaining"] - 1)
        before = game["phase"]
        cls._finish_turn(game)
        return game, before != game["phase"] == SUDDEN_DEATH

    @classmethod
    def _outcome_events(cls, game: Dict[str, Any], result: str) -> List[Dict[str, Any]]:
        if game["phase"] != GAME_OVER:
            return []
        outcome = "team" if game["winner"] == "TEAM" else result
        return [
            {"type": "game_over", "winner": outcome},
            {"type": "game_outcome", "outcome": "win" if outcome == "team" else "loss", "reason": outcome},
        ]

    @classmethod
    def _unrevealed_cells(cls, game: Dict[str, Any]) -> List[int]:
        """Indexes of cards still available to guess (public information)."""
        return [
            i
            for i, cell in enumerate(game["cells"])
            if cell["solvedBy"] is None and cell["assassinatedBy"] is None
        ]

    @staticmethod
    def _clue_target_reached(turn: Optional[Dict[str, Any]]) -> bool:
        """Whether the guesser flipped as many cards as the clue's count.

        Only an integer count has a cap ("infinity" never auto-stops), and at
        least one guess must have been made — ending a turn with zero guesses
        is illegal in the public reducer.
        """
        if not isinstance(turn, dict) or not isinstance(turn.get("clue"), dict):
            return False
        count = turn["clue"].get("count")
        if not isinstance(count, int) or isinstance(count, bool):
            return False
        guesses = turn.get("guesses")
        return isinstance(guesses, list) and len(guesses) >= max(1, count)

    @staticmethod
    def _parse_action_json(raw: str) -> Optional[Dict[str, Any]]:
        """Parse the model's single JSON action, tolerating fenced/prose output."""
        # Some runtimes inline the thinking channel as <think>...</think>; drop
        # it first so brace-rich reasoning text cannot hijack JSON extraction.
        cleaned = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL)
        try:
            data = json.loads(cleaned)
        except Exception:
            match = re.search(r"\{.*\}", cleaned, re.DOTALL)
            if not match:
                return None
            try:
                data = json.loads(match.group(0))
            except Exception:
                return None
        return data if isinstance(data, dict) else None

    @classmethod
    def _valid_guess_cell(cls, game: Dict[str, Any], cell: Any) -> bool:
        """Public-information validity check for a guess target."""
        return (
            isinstance(cell, int)
            and not isinstance(cell, bool)
            and 0 <= cell < 25
            and game["cells"][cell]["solvedBy"] is None
            and game["cells"][cell]["assassinatedBy"] is None
        )

    def reduce(self, actor: str, cmd: Dict[str, Any]) -> ReducerResult:
        command_type = cmd["type"]
        state = deepcopy(self.state)

        if command_type == "startGame":
            if actor not in {"player", "agent"}:
                raise CommandRejected("Unknown actor")
            game = state.get("gameState")
            if actor == "agent" and game and game.get("phase") != GAME_OVER:
                raise CommandRejected("A game is already in progress — only the player may start a new one")
            settings = self._validate_settings(cmd.get("settings"), state["settings"])
            state.update(
                {
                    "gameState": self._new_game(settings),
                    "settings": settings,
                    "counterpartSide": TEAM_A,
                    "agentSide": TEAM_B,
                    "tutorial": {"step": "free_play"} if cmd.get("mode") == "tutorial" else None,
                }
            )
            return ReducerResult(state, {"success": True}, [{"type": "game_start", "counterpartSide": TEAM_A}])

        if command_type == "reset":
            if actor != "player":
                raise CommandRejected("Only player may reset")
            game = state.get("gameState")
            if game and game.get("phase") != GAME_OVER and state.get("tutorial") is None:
                raise CommandRejected("Cannot reset a live game")
            state["gameState"] = None
            state["tutorial"] = None
            return ReducerResult(state, {"success": True})

        if command_type == "restore":
            restored = cmd.get("state")
            if not isinstance(restored, dict):
                raise CommandRejected("state must be an object")
            return ReducerResult(deepcopy(restored), {"success": True})

        game = state.get("gameState")
        if not isinstance(game, dict):
            raise CommandRejected("Game not started")
        side = self._actor_side(state, actor)

        if command_type == "submitClue":
            clue = self._validate_clue(game, cmd.get("clue"))
            self._submit_clue(game, side, clue)
            by = "counterpart" if actor == "player" else "agent"
            events: List[Dict[str, Any]] = [{"type": "clue", "by": by, "word": clue["word"], "count": clue["count"]}]
            return ReducerResult(state, {"success": True, "newState": deepcopy(game)}, events)

        if command_type == "submitGuess":
            cell = cmd.get("cell")
            if isinstance(cell, bool) or not isinstance(cell, int):
                raise CommandRejected("cell must be an integer")
            before = deepcopy(game)
            game, result, turn_ended = self._submit_guess(game, side, cell)
            by = "counterpart" if actor == "player" else "agent"
            events: List[Dict[str, Any]] = [
                {"type": "card_reveal", "cell": cell, "by": by},
                {"type": "guess", "by": by, "word": before["board"][cell]["text"], "result": result},
            ]
            if before["phase"] != SUDDEN_DEATH and game["phase"] == SUDDEN_DEATH:
                events.append({"type": "sudden_death"})
            events.extend(self._outcome_events(game, result))
            return ReducerResult(
                state,
                {
                    "success": True,
                    "result": result,
                    "word": before["board"][cell]["text"],
                    "gameStateBefore": before,
                    "gameStateAfter": deepcopy(game),
                    "turnEnded": turn_ended,
                },
                events,
            )

        if command_type == "endTurn":
            game, entered_sudden_death = self._end_turn(game, side)
            by = "counterpart" if actor == "player" else "agent"
            correct = sum(1 for guess in game["history"][-1]["guesses"] if guess["result"] == AGENT)
            events: List[Dict[str, Any]] = [
                {"type": "turn_end", "by": by, "reason": "voluntary", "correctGuesses": correct}
            ]
            if entered_sudden_death:
                events.append({"type": "sudden_death"})
            if game["phase"] == NORMAL and game["whoseTurnToGive"] == state["agentSide"]:
                events.insert(0, {"type": "agent_turn", "action": "clue"})
            return ReducerResult(state, {"success": True, "enteredSuddenDeath": entered_sudden_death}, events)

        if command_type == "tutorialLoadStage":
            if actor != "agent":
                raise CommandRejected("Only agent may load tutorial stages")
            raise CommandRejected("Tutorial stage loading is not available in local free-play mode")

        if command_type == "debugLoadScenario":
            raise CommandRejected("Codenames debug harness is disabled")

        raise CommandRejected(f"Unknown codenames command: {command_type}")

    def agent_next_command(self) -> Optional[Dict[str, Any]]:
        """Return one legal local-agent action; scheduling is owned by World.

        Deliberate non-cheating fallback: this path never reads ``game["key"]``
        for the opponent's pattern, so it may only act on public information
        (board text, revealed status, current clue) plus Nori's own remaining
        agent count. Used when the LLM is unavailable or returns an unusable
        action.
        """
        state = self.state
        game = state.get("gameState")
        if not isinstance(game, dict) or game.get("phase") == GAME_OVER:
            return None
        agent_side = state["agentSide"]
        word_locale = (state.get("settings") or {}).get("wordLocale", "zh-CN")
        default_clue_word = (
            "诺莉"
            if (word_locale and ("zh" in word_locale.lower() or "cn" in word_locale.lower()))
            else ("ノリ" if (word_locale and "ja" in word_locale.lower()) else "NORI")
        )
        if game["phase"] == NORMAL:
            if not game["history"] or game["history"][-1]["endedBy"] is not None:
                if game["whoseTurnToGive"] == agent_side:
                    # Public knowledge only: whether this side still owes clues.
                    if self._remaining_agents(game, agent_side) > 0:
                        return {"type": "submitClue", "clue": {"word": default_clue_word, "count": 1}}
            else:
                turn = game["history"][-1]
                if turn["clueGiver"] != agent_side:
                    if self._clue_target_reached(turn):
                        return {"type": "endTurn"}
                    candidates = self._unrevealed_cells(game)
                    if candidates:
                        return {"type": "submitGuess", "cell": random.choice(candidates)}
        elif game["phase"] == SUDDEN_DEATH and self._remaining_agents(game, agent_side) > 0:
            candidates = self._unrevealed_cells(game)
            if candidates:
                return {"type": "submitGuess", "cell": random.choice(candidates)}
        return None

    async def generate_agent_turn(self) -> Optional[Dict[str, Any]]:
        """Ask the configured LLM for one Codenames action.

        Two views are serialized: the Spymaster view (NORMAL phase, Nori's turn
        to give a clue, no active turn yet) includes only Nori's own side of the
        key; the Guesser view (NORMAL after the player's clue, or SUDDEN_DEATH)
        exposes public information only — board words, revealed status and the
        current clue. The opponent's key is never sent. Returns ``None`` on any
        failure so World falls back to the deterministic non-cheating rules.
        """
        state = self.state
        game = state.get("gameState")
        if not isinstance(game, dict) or game.get("phase") == GAME_OVER:
            return None
        agent_side = state["agentSide"]
        board = game["board"]
        cells = game["cells"]

        history = game.get("history") or []
        active_turn = history[-1] if history and history[-1]["endedBy"] is None else None
        # Spymaster mode exists only in NORMAL phase while awaiting Nori's clue.
        # In SUDDEN_DEATH no clues are possible, so the LLM is always a guesser.
        spymaster_mode = (
            game["phase"] == NORMAL
            and game["whoseTurnToGive"] == agent_side
            and active_turn is None
        )
        if not spymaster_mode and game["phase"] == NORMAL and active_turn is None:
            # Player still owes a clue; there is nothing for Nori to act on.
            return None
        if active_turn is not None and active_turn.get("clueGiver") == agent_side:
            # Player is guessing Nori's clue; the reducer forbids the clue giver
            # from guessing or ending the turn, so any action would be wasted.
            return None

        if spymaster_mode:
            # Spymaster view: Nori knows its own pattern and must craft a clue
            # word (NOT on the board) plus the number of agents it covers.
            board_lines = []
            for i, cell in enumerate(cells):
                role = game["key"][agent_side][i]
                marker = {AGENT: "MY_TEAM", ASSASSIN: "ASSASSIN", BYSTANDER: "BYSTANDER"}.get(role, "?")
                state_txt = "revealed" if (cell["solvedBy"] is not None or cell["assassinatedBy"] is not None) else "hidden"
                board_lines.append(f"{i}: {board[i]['text']} [{marker}] [{state_txt}]")
            live_agents = [
                i for i, cell in enumerate(cells)
                if game["key"][agent_side][i] == AGENT and cell["solvedBy"] is None
            ]
            hidden_words = ", ".join(board[i]["text"] for i in live_agents) or "none left"
            system_prompt = (
                "You are Nori, the Spymaster in Codenames. You know exactly which "
                "cells belong to your team (MY_TEAM). Your job: give ONE single-word "
                "clue that hints at the given MY_TEAM words. The clue word MUST NOT "
                "appear on the board and should not be a compound or the board word "
                "itself. Reply with only one JSON object, no commentary, no markdown: "
                '{"action":"clue","word":"<one-word clue>","count":<1..9>,"cell":null}. '
                "count = how many of your team's words the clue covers (<= number given). "
                "Write the clue in the same language as the board words."
            )
            user_prompt = (
                "phase=NORMAL it is YOUR turn to give a clue.\n"
                "Your team's hidden words to hint at:\n" + hidden_words + "\n"
                "Full board (your perspective):\n" + "\n".join(board_lines) + "\n"
                'Return a single JSON object of the form {"action":"clue",...} now.'
            )
        else:
            # Guesser view: no key pattern for either team. Reveal only board
            # words + revealed status, plus the active clue in NORMAL phase.
            board_lines = []
            for i, cell in enumerate(cells):
                state_txt = "revealed" if (cell["solvedBy"] is not None or cell["assassinatedBy"] is not None) else "hidden"
                board_lines.append(f"{i}: {board[i]['text']} [{state_txt}]")
            system_prompt = (
                "You are Nori, the Guesser in Codenames. You do NOT know where any "
                "team's agents or the assassin are — you only have the board words "
                "and, during NORMAL phase, the Spymaster's clue. Choose the ONE "
                "hidden board word that is most strongly related to the clue, then "
                "stop when you are done. Reply with only one JSON object, no "
                "commentary:\n"
                'To flip a card: {"action":"guess","cell":<0-24>,'
                '"word":null,"count":null} — choose an unrevealed cell, never '
                "invent a word.\n"
                "To voluntarily END your turn (NORMAL phase only, after at least "
                'one guess): {"action":"end","cell":null,"word":null,"count":null}.'
            )
            if game["phase"] == SUDDEN_DEATH:
                user_prompt = (
                    "phase=SUDDEN_DEATH: no clues remain for either side. Take your "
                    "ONE final guess at the hidden board word most likely to belong "
                    "to your team; you cannot end this turn.\n"
                    "Board:\n" + "\n".join(board_lines) + "\n"
                    'Return a single JSON object {"action":"guess","cell":<0-24>,...} now.'
                )
            else:
                clue = active_turn.get("clue") if isinstance(active_turn, dict) else None
                clue_word = str(clue.get("word") or "") if isinstance(clue, dict) else ""
                clue_count = str(clue.get("count") or "") if isinstance(clue, dict) else ""
                guessed_this_turn = len(active_turn.get("guesses") or []) if isinstance(active_turn, dict) else 0
                user_prompt = (
                    "phase=NORMAL it is YOUR turn to guess.\n"
                    f'The clue is: "{clue_word}" (targets ~{clue_count} cards).\n'
                    f"You have already guessed {guessed_this_turn} card(s) this turn.\n"
                    "Guess one more board card you think fits, or end your turn if you "
                    "are done or uncertain.\n"
                    "Board:\n" + "\n".join(board_lines) + "\n"
                    'Return a single JSON object {"action":...} now.'
                )

        # Thinking models burn many tokens before emitting the JSON answer, so
        # the budget must be generous or `content` stays empty (finish=length).
        # generate_structured retries with a 4x budget when that happens. The
        # schema constrains output (and stops the hidden reasoning drain) where
        # the provider supports it; JSON extraction still covers the rest.
        # NOTE: every property needs a concrete type — LM Studio's grammar
        # converter renders an empty `{}` property as a literal `{}` value,
        # which used to turn every guess cell into `{}` and silently push the
        # agent onto the fallback rules. Optional fields are simply omitted.
        action_schema: Dict[str, Any] = {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["clue", "guess", "end"]},
                "word": {"type": "string"},
                "count": {"type": "integer"},
                "cell": {"type": "integer"},
            },
            "required": ["action"],
        }
        raw = await LLM_SERVICE.generate_structured(
            system_prompt, user_prompt, temperature=0.4, max_tokens=4096, json_schema=action_schema
        )
        data = self._parse_action_json(raw) if raw else None
        if data is None and raw:
            # One retry with the same prompt before falling back to rules.
            print("[nori-codenames] LLM action unparseable; retrying once")
            raw = await LLM_SERVICE.generate_structured(
                system_prompt, user_prompt, temperature=0.4, max_tokens=4096, json_schema=action_schema
            )
            data = self._parse_action_json(raw) if raw else None
        if data is None:
            if not raw:
                print("[nori-codenames] no LLM response; using non-cheating fallback")
            else:
                print("[nori-codenames] LLM action unparseable after retry; using fallback")
            return None

        action = str(data.get("action") or "")
        if game["phase"] != NORMAL:
            # SUDDEN_DEATH: exactly one guess, no clues, no voluntary ending.
            if action != "guess":
                print(f"[nori-codenames] ignoring non-guess action {action!r} in {game['phase']}")
                return None
            cell = data.get("cell")
            if not self._valid_guess_cell(game, cell):
                print("[nori-codenames] LLM returned invalid guess cell; using fallback")
                return None
            return {"type": "submitGuess", "cell": cell}

        # NORMAL phase: clue when Spymaster, guess/end when Guesser.
        if spymaster_mode and action != "guess":
            word = str(data.get("word") or "").strip().upper()
            count = data.get("count")
            if not word or len(word) > 24 or re.search(r"\s|\d", word):
                print("[nori-codenames] LLM returned invalid clue word; using fallback")
                return None
            if word in {entry["text"].upper() for entry in board}:
                print("[nori-codenames] LLM clue matches a board word; using fallback")
                return None
            if count != "infinity" and (isinstance(count, bool) or not isinstance(count, int) or count < 0):
                count = 1
            return {"type": "submitClue", "clue": {"word": word, "count": count if isinstance(count, int) else 1}}

        guessed_count = len(active_turn.get("guesses") or []) if isinstance(active_turn, dict) else 0
        # End when the LLM stops, or deterministically once the clue target is
        # reached. "infinity" has no cap, so the LLM explicitly stops instead.
        if action == "end" or self._clue_target_reached(active_turn):
            if guessed_count >= 1:
                return {"type": "endTurn"}
            print("[nori-codenames] cannot end before any guess; requesting one more")
        cell = data.get("cell")
        if not self._valid_guess_cell(game, cell):
            print("[nori-codenames] LLM returned invalid guess cell; using fallback")
            return None
        return {"type": "submitGuess", "cell": cell}
