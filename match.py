#!/usr/bin/env python3
"""
五子棋对战匹配系统
用于执行两个AI Agent之间的多局比赛
"""

import argparse
import contextlib
import importlib.util
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError, as_completed

# 添加gomoku目录到Python路径
current_dir = os.path.dirname(os.path.abspath(__file__))
gomoku_dir = os.path.join(current_dir, "gomoku")
sys.path.insert(0, gomoku_dir)

from gomoku import PLAYER_TIME_LIMIT, play_game

RESULT_JSON_BEGIN = "__GOMOKU_MATCH_RESULT_JSON_BEGIN__"
RESULT_JSON_END = "__GOMOKU_MATCH_RESULT_JSON_END__"
MOVE_PROCESS_TIMEOUT = PLAYER_TIME_LIMIT + 1.0


class AgentLoader:
    """Agent加载器，负责从文件中加载AI Agent"""

    @staticmethod
    def load_agent_from_file(file_path, player_id):
        """
        从文件中加载Agent

        @param file_path: Agent文件路径
        @param player_id: 玩家ID (1或2)
        @return: Agent实例
        """
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Agent文件不存在: {file_path}")

        # 获取文件名（不含扩展名）作为模块名
        module_name = os.path.splitext(os.path.basename(file_path))[0]

        # 动态加载模块
        spec = importlib.util.spec_from_file_location(module_name, file_path)
        if spec is None:
            raise ImportError(f"无法加载模块: {file_path}")

        # 确保agent模块可用
        try:
            import gomoku.agent

            sys.modules["gomoku.agent"] = gomoku.agent
        except ImportError:
            pass

        module = importlib.util.module_from_spec(spec)

        try:
            spec.loader.exec_module(module)
        except Exception as e:
            raise RuntimeError(f"执行模块失败: {e}")

        # 查找Agent类 - 优先查找Search类，然后查找Agent类
        agent_class = None

        if hasattr(module, "Search"):
            agent_class = getattr(module, "Search")
        elif hasattr(module, "Agent"):
            agent_class = getattr(module, "Agent")
        else:
            # 查找所有继承自Agent的类
            from gomoku.agent import Agent as BaseAgent

            for attr_name in dir(module):
                attr = getattr(module, attr_name)
                if (
                    isinstance(attr, type)
                    and issubclass(attr, BaseAgent)
                    and attr != BaseAgent
                ):
                    agent_class = attr
                    break

            if agent_class is None:
                raise AttributeError(f"在{file_path}中找不到Search类或继承自Agent的类")

        # 创建Agent实例
        try:
            return agent_class(player_id)
        except Exception as e:
            raise RuntimeError(f"创建Agent实例失败: {e}")


class IsolatedAgent:
    """Agent proxy that runs one persistent worker process per game."""

    def __init__(self, file_path, player_id):
        self.file_path = file_path
        self.player = player_id
        self.opponent = 3 - player_id
        self.process = None
        self.response_executor = ThreadPoolExecutor(max_workers=1)

    def _ensure_process(self):
        if self.process is not None and self.process.poll() is None:
            return

        self.process = subprocess.Popen(
            [
                sys.executable,
                os.path.abspath(__file__),
                "--agent-worker",
                self.file_path,
                "--move-player",
                str(self.player),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
            bufsize=1,
            cwd=current_dir,
        )

    def make_move(self, board):
        self._ensure_process()
        board_data = board.tolist() if hasattr(board, "tolist") else board
        payload = json.dumps({"board": board_data}, ensure_ascii=False) + "\n"

        try:
            self.process.stdin.write(payload)
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            self.close()
            raise RuntimeError("Agent worker process is unavailable") from exc

        future = self.response_executor.submit(self.process.stdout.readline)
        try:
            response_line = future.result(timeout=MOVE_PROCESS_TIMEOUT)
        except FutureTimeoutError as exc:
            self.close(kill=True)
            raise TimeoutError(
                f"Agent move exceeded {PLAYER_TIME_LIMIT:.0f} seconds"
            ) from exc

        if not response_line:
            exit_code = self.process.poll()
            self.close()
            raise RuntimeError(
                f"Agent worker exited unexpectedly with code {exit_code}"
            )

        try:
            result = json.loads(response_line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"Agent move returned invalid JSON: {response_line[:500]}"
            ) from exc

        move = _list_to_tuple(result.get("move"))
        skill = _list_to_tuple(result.get("skill"))
        return move, skill

    def close(self, kill=False):
        process = self.process
        self.process = None

        if process is not None:
            try:
                if process.stdin:
                    process.stdin.close()
            except OSError:
                pass

            try:
                if process.poll() is None:
                    if kill:
                        process.kill()
                    else:
                        process.terminate()
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=1)

        self.response_executor.shutdown(wait=False, cancel_futures=True)


def _list_to_tuple(value):
    if value is None:
        return None
    if isinstance(value, list):
        return tuple(value)
    return value


def _json_safe(value):
    if hasattr(value, "item"):
        return value.item()
    if isinstance(value, tuple):
        return [_json_safe(item) for item in value]
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


def run_move_worker(agent_path, player_id):
    payload = json.load(sys.stdin)
    agent = AgentLoader.load_agent_from_file(agent_path, player_id)
    move_result = agent.make_move(payload["board"])

    if isinstance(move_result, tuple) and len(move_result) == 2:
        move, skill = move_result
    else:
        move, skill = move_result, None

    return {"move": _json_safe(move), "skill": _json_safe(skill)}


def run_agent_worker(agent_path, player_id, output_stream):
    agent = AgentLoader.load_agent_from_file(agent_path, player_id)

    for line in sys.stdin:
        if not line.strip():
            continue

        payload = json.loads(line)
        with contextlib.redirect_stdout(sys.stderr):
            move_result = agent.make_move(payload["board"])

        if isinstance(move_result, tuple) and len(move_result) == 2:
            move, skill = move_result
        else:
            move, skill = move_result, None

        print(
            json.dumps({"move": _json_safe(move), "skill": _json_safe(skill)}, ensure_ascii=False),
            file=output_stream,
            flush=True,
        )


class MatchEngine:
    """比赛引擎，负责执行比赛和记录结果"""

    def __init__(self, board_size=15):
        self.board_size = board_size

    def _run_single_game(self, agent1_path, agent2_path, game_num):
        """
        执行单局比赛

        @param agent1_path: 挑战者Agent文件路径
        @param agent2_path: 防守者Agent文件路径
        @param game_num: 比赛局数编号
        @return: 单局比赛结果
        """
        start_time = time.time()

        try:
            # 每局比赛重新加载Agent以避免状态污染
            agent1 = IsolatedAgent(agent1_path, 1)
            agent2 = IsolatedAgent(agent2_path, 2)

            # 交替先手，保证公平性
            if game_num % 2 == 0:
                # agent1先手
                winner, game_record = play_game(
                    agent1, agent2, self.board_size, silent=True, record_moves=True
                )
            else:
                # agent2先手
                winner, game_record = play_game(
                    agent2, agent1, self.board_size, silent=True, record_moves=True
                )
                # 调整winner编号，因为agent2先手时编号变了
                if winner == 1:
                    winner = 2
                elif winner == 2:
                    winner = 1
                # 调整游戏记录中的玩家编号
                for move in game_record["moves"]:
                    if move["player"] == 1:
                        move["player"] = 2
                    elif move["player"] == 2:
                        move["player"] = 1
                # 调整玩家统计信息
                if "player_statistics" in game_record:
                    old_stats = game_record["player_statistics"]
                    game_record["player_statistics"] = {
                        1: old_stats.get(
                            2, {"moves": 0, "total_time": 0, "average_time": 0}
                        ),
                        2: old_stats.get(
                            1, {"moves": 0, "total_time": 0, "average_time": 0}
                        ),
                    }

                if "skill_casts" in game_record:
                    for cast in game_record["skill_casts"]:
                        if cast["player"] == 1:
                            cast["player"] = 2
                        elif cast["player"] == 2:
                            cast["player"] = 1
            agent1.close()
            agent2.close()
        except Exception as e:
            if "agent1" in locals():
                agent1.close(kill=True)
            if "agent2" in locals():
                agent2.close(kill=True)
            # 异常情况下认为挑战者失败
            winner = 2
            game_record = {
                "error": str(e),
                "board_size": self.board_size,
                "start_time": start_time,
                "end_time": time.time(),
                "duration": time.time() - start_time,
                "winner": 2,
                "moves": [],
                "total_moves": 0,
                "player_statistics": {
                    1: {"moves": 0, "total_time": 0, "average_time": 0},
                    2: {"moves": 0, "total_time": 0, "average_time": 0},
                },
            }

        end_time = time.time()
        game_duration = end_time - start_time

        return {
            "game": game_num + 1,
            "winner": winner,
            "duration": game_duration,
            "challenger_first": game_num % 2 == 0,
            "game_record": game_record,
        }

    def run_match(
        self, agent1_path, agent2_path, games=5, silent=True, max_workers=5
    ):
        """
        执行一场比赛（并发版本）

        @param agent1_path: 挑战者Agent文件路径
        @param agent2_path: 防守者Agent文件路径
        @param games: 比赛局数
        @param silent: 是否静默模式
        @param max_workers: 最大并发工作线程数
        @return: 比赛结果字典
        """
        try:
            if not silent:
                print(
                    f"开始比赛: {os.path.basename(agent1_path)} vs {os.path.basename(agent2_path)}"
                )
                print(f"比赛局数: {games}")
                print("-" * 50)

            # 记录比赛结果
            results = {
                "winner": None,
                "challenger_wins": 0,
                "defender_wins": 0,
                "draws": 0,
                "games": [],
                "total_games": games,
                "challenger_path": agent1_path,
                "defender_path": agent2_path,
                "timestamp": datetime.now().isoformat(),
                "board_size": self.board_size,
                "success": True,
            }

            # 使用线程池并发执行比赛
            with ThreadPoolExecutor(max_workers=min(max_workers, games)) as executor:
                # 提交所有比赛任务
                future_to_game = {
                    executor.submit(
                        self._run_single_game, agent1_path, agent2_path, game_num
                    ): game_num
                    for game_num in range(games)
                }

                # 收集结果
                completed_games = 0
                for future in as_completed(future_to_game):
                    game_num = future_to_game[future]
                    try:
                        game_result = future.result()
                        completed_games += 1

                        # 统计胜负
                        winner = game_result["winner"]
                        if winner == 0:  # 平局
                            results["draws"] += 1
                            result_text = "平局"
                        elif winner == 1:
                            # 挑战者获胜
                            results["challenger_wins"] += 1
                            result_text = f"{os.path.basename(agent1_path)} 获胜"
                        else:
                            # 防守者获胜
                            results["defender_wins"] += 1
                            result_text = f"{os.path.basename(agent2_path)} 获胜"

                        if not silent:
                            print(
                                f"第 {game_result['game']} 局: {result_text} (耗时: {game_result['duration']:.2f}s) [{completed_games}/{games}]"
                            )

                        results["games"].append(game_result)

                    except Exception as e:
                        if not silent:
                            print(f"第 {game_num + 1} 局执行失败: {e}")
                        # 异常情况下认为防守者获胜
                        results["defender_wins"] += 1
                        results["games"].append(
                            {
                                "game": game_num + 1,
                                "winner": 2,
                                "duration": 0,
                                "challenger_first": game_num % 2 == 0,
                                "error": str(e),
                            }
                        )

            # 按游戏编号排序结果
            results["games"].sort(key=lambda x: x["game"])

            # 计算胜率
            results["challenger_win_rate"] = results["challenger_wins"] / games
            results["defender_win_rate"] = results["defender_wins"] / games
            results["draw_rate"] = results["draws"] / games

            # 确定比赛赢家
            if results["challenger_wins"] > results["defender_wins"]:
                results["winner"] = "challenger"
            elif results["defender_wins"] > results["challenger_wins"]:
                results["winner"] = "defender"
            else:
                results["winner"] = "tie"

            if not silent:
                print("-" * 50)
                print("比赛结果:")
                print(
                    f"{os.path.basename(agent1_path)}: {results['challenger_wins']} 胜"
                )
                print(f"{os.path.basename(agent2_path)}: {results['defender_wins']} 胜")
                print(f"平局: {results['draws']} 局")
                print(f"比赛赢家: {results['winner']}")

            return results

        except Exception as e:
            error_result = {
                "winner": "defender",
                "challenger_wins": 0,
                "defender_wins": games,
                "total_games": games,
                "error": str(e),
                "challenger_path": agent1_path,
                "defender_path": agent2_path,
                "timestamp": datetime.now().isoformat(),
                "success": False,
            }
            if not silent:
                print(f"比赛执行失败: {e}")
            return error_result


def main():
    """主函数"""
    original_stdout = sys.stdout
    parser = argparse.ArgumentParser(description="五子棋AI对战系统")

    parser.add_argument("--challenger", "-c", help="挑战者Agent文件路径")
    parser.add_argument("--defender", "-d", help="防守者Agent文件路径")
    parser.add_argument("--move-agent", help=argparse.SUPPRESS)
    parser.add_argument("--agent-worker", help=argparse.SUPPRESS)
    parser.add_argument("--move-player", type=int, help=argparse.SUPPRESS)
    parser.add_argument(
        "--games", "-g", type=int, default=5, help="比赛局数 (默认: 5)"
    )
    parser.add_argument(
        "--board-size", "-s", type=int, default=15, help="棋盘大小 (默认: 15)"
    )
    parser.add_argument("--output", "-o", help="结果输出文件路径 (JSON格式)")
    parser.add_argument(
        "--silent", action="store_true", help="静默模式，不打印比赛过程"
    )
    parser.add_argument(
        "--workers", "-w", type=int, default=5, help="最大并发工作线程数 (默认: 5)"
    )

    args = parser.parse_args()

    if args.move_agent:
        if args.move_player not in (1, 2):
            print("错误: move-player必须为1或2", file=sys.stderr)
            sys.exit(1)
        move_result = None
        with contextlib.redirect_stdout(sys.stderr):
            move_result = run_move_worker(args.move_agent, args.move_player)
        print(json.dumps(move_result, ensure_ascii=False), file=original_stdout)
        return

    if args.agent_worker:
        if args.move_player not in (1, 2):
            print("错误: move-player必须为1或2", file=sys.stderr)
            sys.exit(1)
        worker_stdout = original_stdout
        with contextlib.redirect_stdout(sys.stderr):
            run_agent_worker(args.agent_worker, args.move_player, worker_stdout)
        return

    if not args.challenger or not args.defender:
        parser.error("--challenger and --defender are required")

    # 验证文件存在
    if not os.path.exists(args.challenger):
        print(f"错误: 挑战者文件不存在: {args.challenger}", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(args.defender):
        print(f"错误: 防守者文件不存在: {args.defender}", file=sys.stderr)
        sys.exit(1)

    # 创建比赛引擎
    engine = MatchEngine(args.board_size)

    # Uploaded agents may print during import or make_move. Keep stdout reserved for
    # the machine-readable result and send incidental output to stderr.
    with contextlib.redirect_stdout(sys.stderr):
        results = engine.run_match(
            args.challenger,
            args.defender,
            args.games,
            args.silent,
            min(args.workers, args.games),
        )

    # 输出结果
    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(results, f, ensure_ascii=False, indent=2)
            if not args.silent:
                print(f"\n结果已保存到: {args.output}")
        except Exception as e:
            print(f"保存结果失败: {e}")
            sys.exit(1)
    else:
        # 如果没有指定输出文件，打印JSON到标准输出
        print(RESULT_JSON_BEGIN, file=original_stdout)
        print(json.dumps(results, ensure_ascii=False, indent=2), file=original_stdout)
        print(RESULT_JSON_END, file=original_stdout)


if __name__ == "__main__":
    main()
