#!/usr/bin/env python3
"""Terminal match visualizer for recorded gomoku games."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
MAGENTA = "\033[35m"
RED = "\033[31m"
BLUE = "\033[34m"
PANEL = "\033[38;5;244m"

EMPTY = 0
PLAYER1_STONE = 1
PLAYER2_STONE = 2
PLAYER1_SKILL = 3
PLAYER2_SKILL = 4

VALID_RESULTS = {"valid", "winning_move", "draw_move"}
TERMINAL_RESULTS = {
    "winning_move",
    "draw_move",
    "timeout",
    "exception",
    "invalid_move",
    "invalid_position",
    "blocked_position",
}


@dataclass
class Frame:
    move_index: int
    board: list[list[int]]
    move: dict[str, Any] | None
    caption: str


def enable_ansi_on_windows() -> None:
    if os.name != "nt":
        return

    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel32.SetConsoleMode(handle, mode.value | 0x0004)
    except Exception:
        pass


def clear_screen() -> None:
    sys.stdout.write("\033[2J\033[H")
    sys.stdout.flush()


def clone_board(board: list[list[int]]) -> list[list[int]]:
    return [row[:] for row in board]


def create_board(size: int) -> list[list[int]]:
    return [[EMPTY for _ in range(size)] for _ in range(size)]


def get_skill_marker(player: int) -> int:
    return PLAYER1_SKILL if player == 1 else PLAYER2_SKILL


def is_valid_position(board: list[list[int]], row: int, col: int) -> bool:
    size = len(board)
    return 0 <= row < size and 0 <= col < size


def clear_block_for_player(
    board: list[list[int]], blocked_cell_for_player: dict[int, tuple[int, int] | None], player: int
) -> None:
    blocked_cell = blocked_cell_for_player[player]
    if blocked_cell is None:
        return

    row, col = blocked_cell
    caster = 3 - player
    expected_marker = get_skill_marker(caster)

    if is_valid_position(board, row, col) and board[row][col] == expected_marker:
        board[row][col] = EMPTY

    blocked_cell_for_player[player] = None


def color(text: str, tone: str) -> str:
    return f"{tone}{text}{RESET}"


def panel_line(char: str = "─", width: int = 90) -> str:
    return color(char * width, PANEL)


def centered(title: str, width: int = 90) -> str:
    return color(title.center(width), PANEL)


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def winner_label(match: dict[str, Any], winner: Any) -> str:
    if winner == "tie" or winner == 0:
        return color("Draw", YELLOW)
    if winner == 1:
        return f"{color('P1', CYAN)} {match['challenger_submission_id']}"
    if winner == 2:
        return f"{color('P2', MAGENTA)} {match['defender_submission_id']}"
    if winner == match.get("challenger_submission_id"):
        return f"{color('Challenger', CYAN)} {winner}"
    if winner == match.get("defender_submission_id"):
        return f"{color('Defender', MAGENTA)} {winner}"
    return str(winner)


def side_for_player(match: dict[str, Any], game: dict[str, Any], player: int) -> tuple[str, str]:
    challenger_first = bool(game.get("challenger_first"))
    if challenger_first:
        if player == 1:
            return "challenger", match["challenger_submission_id"]
        if player == 2:
            return "defender", match["defender_submission_id"]
    else:
        if player == 1:
            return "defender", match["defender_submission_id"]
        if player == 2:
            return "challenger", match["challenger_submission_id"]
    return "unknown", f"player-{player}"


def game_winner_label(match: dict[str, Any], game: dict[str, Any], winner: Any) -> str:
    if winner == "tie" or winner == 0:
        return color("Draw", YELLOW)
    if winner in (1, 2):
        side, submission_id = side_for_player(match, game, winner)
        tone = CYAN if side == "challenger" else MAGENTA
        return f"{color(side.capitalize(), tone)} {submission_id}"
    return winner_label(match, winner)


def move_status_label(result: str) -> str:
    if result in {"winning_move"}:
        return color(result, GREEN)
    if result in {"draw_move"}:
        return color(result, YELLOW)
    if result in {"valid"}:
        return color(result, CYAN)
    return color(result, RED)


def symbol_for(cell: int) -> str:
    if cell == PLAYER1_STONE:
        return color("●", CYAN)
    if cell == PLAYER2_STONE:
        return color("○", MAGENTA)
    if cell == PLAYER1_SKILL:
        return color("◇", BLUE)
    if cell == PLAYER2_SKILL:
        return color("◆", YELLOW)
    return color("·", PANEL)


def read_matches(matches_path: Path) -> list[dict[str, Any]]:
    with matches_path.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)
    matches = payload.get("matches", [])
    if not isinstance(matches, list):
        raise ValueError("matches.json does not contain a 'matches' array")
    return matches


def prompt_index(max_value: int, allow_back: bool = False) -> int | None:
    while True:
        raw = input(color("Select number", BOLD) + (" (`b` to go back): " if allow_back else ": ")).strip()
        if allow_back and raw.lower() == "b":
            return None
        if raw.isdigit():
            number = int(raw)
            if 1 <= number <= max_value:
                return number - 1
        print(color("Invalid selection.", RED))


def render_match_menu(matches: list[dict[str, Any]]) -> int | None:
    while True:
        clear_screen()
        print(panel_line("═"))
        print(centered(f"{BOLD}GOMOKU MATCH VISUALIZER{RESET}"))
        print(panel_line("═"))
        print(color("Choose a match by submission ids.", DIM))
        print()

        for index, match in enumerate(matches, start=1):
            stamp = match.get("timestamp", "unknown time")
            summary = (
                f"[{index:02}] "
                f"{color(match.get('challenger_submission_id', '?'), CYAN)}"
                f"  vs  "
                f"{color(match.get('defender_submission_id', '?'), MAGENTA)}"
                f"    winner: {winner_label(match, match.get('winner'))}"
                f"    games: {safe_int(match.get('games_played') or len(match.get('games', [])))}"
            )
            print(summary)
            print(color(f"     match id: {match.get('id', 'unknown')}    time: {stamp}", PANEL))

        print()
        choice = prompt_index(len(matches))
        if choice is not None:
            return choice


def render_game_menu(match: dict[str, Any]) -> int | None:
    games = match.get("games", [])
    while True:
        clear_screen()
        print(panel_line("═"))
        print(centered(f"{BOLD}MATCH{RESET}  {match['challenger_submission_id']}  vs  {match['defender_submission_id']}"))
        print(panel_line("═"))
        print(color(f"Winner: {winner_label(match, match.get('winner'))}", DIM))
        print()

        for index, game in enumerate(games, start=1):
            record = game.get("game_record", {})
            total_steps = len(record.get("moves", []))
            winner = game_winner_label(match, game, game.get("winner"))
            first = match["challenger_submission_id"] if game.get("challenger_first") else match["defender_submission_id"]
            print(
                f"[{index:02}] winner: {winner}    steps: {total_steps}    "
                f"first: {first}    duration: {game.get('duration', 0):.2f}s"
            )

        print()
        choice = prompt_index(len(games), allow_back=True)
        if choice is not None or choice is None:
            return choice


def format_board(board: list[list[int]]) -> str:
    size = len(board)
    lines = []
    header = "    " + " ".join(f"{col:02}" for col in range(size))
    lines.append(color(header, PANEL))

    for row_index, row in enumerate(board):
        cells = " ".join(symbol_for(cell) for cell in row)
        lines.append(color(f"{row_index:02} ", PANEL) + " " + cells)

    return "\n".join(lines)


def build_frames(match: dict[str, Any], game: dict[str, Any]) -> list[Frame]:
    record = game.get("game_record", {})
    board_size = safe_int(record.get("board_size"), 15)
    moves = record.get("moves", [])
    skill_casts = record.get("skill_casts", [])

    board = create_board(board_size)
    blocked_cell_for_player: dict[int, tuple[int, int] | None] = {1: None, 2: None}
    skill_by_move = {safe_int(cast.get("move_number")): cast for cast in skill_casts}

    frames = [
        Frame(
            move_index=0,
            board=clone_board(board),
            move=None,
            caption="Start position",
        )
    ]

    for move in moves:
        move_number = safe_int(move.get("move_number"))
        player = safe_int(move.get("player"))
        result = str(move.get("result", "unknown"))

        cast = skill_by_move.get(move_number)
        if cast:
            position = cast.get("position") or []
            if len(position) == 2:
                row, col = safe_int(position[0]), safe_int(position[1])
                if is_valid_position(board, row, col):
                    board[row][col] = get_skill_marker(player)
                    blocked_cell_for_player[3 - player] = (row, col)

        move_pos = move.get("move")
        if result in VALID_RESULTS and isinstance(move_pos, list) and len(move_pos) == 2:
            row, col = safe_int(move_pos[0]), safe_int(move_pos[1])
            if is_valid_position(board, row, col):
                board[row][col] = player

        if result not in TERMINAL_RESULTS:
            clear_block_for_player(board, blocked_cell_for_player, player)

        frames.append(
            Frame(
                move_index=move_number,
                board=clone_board(board),
                move=move,
                caption=describe_move(move, cast),
            )
        )

    return frames


def describe_move(move: dict[str, Any], skill_cast: dict[str, Any] | None) -> str:
    player = safe_int(move.get("player"))
    result = str(move.get("result", "unknown"))
    move_pos = move.get("move")
    pieces = [f"move {safe_int(move.get('move_number'))}", f"player {player}"]

    if isinstance(move_pos, list) and len(move_pos) == 2:
        pieces.append(f"stone ({safe_int(move_pos[0])}, {safe_int(move_pos[1])})")
    else:
        pieces.append("no stone")

    if skill_cast and isinstance(skill_cast.get("position"), list) and len(skill_cast["position"]) == 2:
        skill_row, skill_col = skill_cast["position"]
        pieces.append(f"skill ({skill_row}, {skill_col})")

    pieces.append(f"time {float(move.get('time_taken', 0)):.3f}s")
    pieces.append(f"status {result}")

    if move.get("error"):
        pieces.append(f"error {move['error']}")

    return " | ".join(str(piece) for piece in pieces)


def render_frame(match: dict[str, Any], game: dict[str, Any], frames: list[Frame], frame_index: int, mode: str) -> None:
    frame = frames[frame_index]
    move = frame.move
    total = max(len(frames) - 1, 0)
    clear_screen()

    print(panel_line("═"))
    print(centered(f"{BOLD}GOMOKU REPLAY{RESET}"))
    print(panel_line("═"))
    print(
        f"{color(match['challenger_submission_id'], CYAN)} vs "
        f"{color(match['defender_submission_id'], MAGENTA)}"
        f"    game: {game.get('game_number', '?')}"
        f"    mode: {mode}"
    )
    print(
        f"winner: {game_winner_label(match, game, game.get('winner'))}    "
        f"frame: {frame_index}/{total}"
    )
    print(color(frame.caption, DIM))
    if move:
        print(
            f"status: {move_status_label(str(move.get('result', 'unknown')))}    "
            f"step time: {float(move.get('time_taken', 0)):.3f}s"
        )
    print()
    print(format_board(frame.board))
    print()


def autoplay(match: dict[str, Any], game: dict[str, Any], frames: list[Frame], interval: float) -> None:
    for index in range(len(frames)):
        render_frame(match, game, frames, index, f"autoplay {interval:.1f}s/step")
        time.sleep(interval)


class KeyReader:
    def __enter__(self) -> "KeyReader":
        self._windows = os.name == "nt"
        self._fd = None
        self._old_settings = None

        if not self._windows:
            import termios
            import tty

            self._fd = sys.stdin.fileno()
            self._old_settings = termios.tcgetattr(self._fd)
            tty.setraw(self._fd)

        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if not self._windows and self._fd is not None and self._old_settings is not None:
            import termios

            termios.tcsetattr(self._fd, termios.TCSADRAIN, self._old_settings)

    def read_key(self) -> str:
        if self._windows:
            import msvcrt

            while True:
                key = msvcrt.getwch()
                if key not in ("\x00", "\xe0"):
                    return key
                msvcrt.getwch()

        return sys.stdin.read(1)


def step_mode(match: dict[str, Any], game: dict[str, Any], frames: list[Frame]) -> str:
    index = len(frames) - 1

    with KeyReader() as reader:
        while True:
            render_frame(match, game, frames, index, "step")
            print(color("Controls: j previous | k next | r replay autoplay | g choose game | m choose match | q quit", BOLD))
            key = reader.read_key().lower()

            if key == "j":
                index = max(0, index - 1)
            elif key == "k":
                index = min(len(frames) - 1, index + 1)
            elif key == "r":
                return "replay"
            elif key == "g":
                return "game"
            elif key == "m":
                return "match"
            elif key == "q":
                return "quit"


def play_game_loop(match: dict[str, Any], game: dict[str, Any], interval: float) -> str:
    frames = build_frames(match, game)
    autoplay(match, game, frames, interval)
    return step_mode(match, game, frames)


def run_visualizer(matches_path: Path, interval: float) -> int:
    matches = read_matches(matches_path)
    if not matches:
        print("No matches found in", matches_path)
        return 1

    while True:
        match_index = render_match_menu(matches)
        if match_index is None:
            return 0
        match = matches[match_index]

        while True:
            game_index = render_game_menu(match)
            if game_index is None:
                break
            game = match.get("games", [])[game_index]

            while True:
                action = play_game_loop(match, game, interval)
                if action == "replay":
                    continue
                if action == "game":
                    break
                if action == "match":
                    game_index = None
                    break
                if action == "quit":
                    clear_screen()
                    return 0

            if game_index is None:
                break


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Visualize recorded gomoku matches in the terminal.")
    parser.add_argument(
        "--matches",
        default=str(Path(__file__).resolve().parent / "data" / "matches.json"),
        help="Path to matches.json",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=0.5,
        help="Autoplay interval in seconds for each step.",
    )
    return parser.parse_args()


def main() -> int:
    enable_ansi_on_windows()
    args = parse_args()
    matches_path = Path(args.matches).resolve()

    if not matches_path.exists():
        print(color(f"matches file not found: {matches_path}", RED))
        return 1

    try:
        return run_visualizer(matches_path, args.interval)
    except KeyboardInterrupt:
        clear_screen()
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
