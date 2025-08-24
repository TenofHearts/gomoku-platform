import argparse
import importlib
import numpy as np
import time
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError

PLAYER_TIME_LIMIT = 60.0


def create_board(board_size=15):
    """
    创建棋盘

    @param board_size: 棋盘大小, 默认15x15(标准五子棋棋盘)
    @return: 棋盘数组
    """
    return np.zeros((board_size, board_size), dtype=int)


def is_valid_move(board, row, col):
    """
    检查移动是否有效

    @param board: 棋盘
    @param row: 行坐标
    @param col: 列坐标
    @return: 是否有效
    """
    board_size = len(board)
    return 0 <= row < board_size and 0 <= col < board_size and board[row][col] == 0


def make_move(board, row, col, player):
    """
    在指定位置落子

    @param board: 棋盘
    @param row: 行坐标
    @param col: 列坐标
    @param player: 玩家编号 (1或2)
    @return: 是否成功落子
    """
    if not is_valid_move(board, row, col):
        return False

    board[row][col] = player
    return True


def is_board_full(board):
    """
    检查棋盘是否已满

    @param board: 棋盘
    @return: 是否已满
    """
    return np.all(board != 0)


def check_win(board, row, col):
    """
    检查从指定位置是否形成五子连珠

    @param board: 棋盘
    @param row: 最后落子的行坐标
    @param col: 最后落子的列坐标
    @return: 是否获胜
    """
    board_size = len(board)
    player = board[row][col]

    directions = [
        (0, 1),
        (1, 0),
        (1, 1),
        (1, -1),
    ]

    for dx, dy in directions:
        count = 1

        x, y = row + dx, col + dy
        while 0 <= x < board_size and 0 <= y < board_size and board[x][y] == player:
            count += 1
            x, y = x + dx, y + dy

        x, y = row - dx, col - dy
        while 0 <= x < board_size and 0 <= y < board_size and board[x][y] == player:
            count += 1
            x, y = x - dx, y - dy

        if count >= 5:
            return True

    return False


def print_board(board):
    """
    打印棋盘

    @param board: 棋盘
    """
    board_size = len(board)
    print("  ", end="")
    for j in range(board_size):
        print(f"{j:2}", end="")
    print()

    for i in range(board_size):
        print(f"{i:2}", end="")
        for j in range(board_size):
            if board[i][j] == 0:
                print(" .", end="")
            elif board[i][j] == 1:
                print(" ●", end="")
            else:
                print(" ○", end="")
        print()


def play_game(
    agent1=None, agent2=None, board_size=15, silent=False, record_moves=False
):
    """
    进行一局游戏

    @param agent1: 玩家1的Agent, 如果为None则使用默认Agent
    @param agent2: 玩家2的Agent, 如果为None则使用默认Agent
    @param board_size: 棋盘大小, 默认15x15(标准五子棋棋盘)
    @param silent: 是否静默模式，不打印游戏过程
    @param record_moves: 是否记录详细的移动过程
    @return: 如果record_moves为True，返回(winner, game_record)，否则返回winner
    """
    board = create_board(board_size)
    current_player = 1
    game_over = False
    winner = None
    move_count = 0

    # 记录游戏过程
    game_record = (
        {
            "board_size": board_size,
            "start_time": time.time(),
            "moves": [],
            "board_states": [] if record_moves else None,
            "player_times": [],
        }
        if record_moves
        else None
    )

    agents = {1: agent1, 2: agent2}

    if not silent:
        print("游戏开始! ")
        print(f"玩家操作时间限制: {PLAYER_TIME_LIMIT}秒")
        print_board(board)

    # 记录初始棋盘状态
    if record_moves:
        game_record["board_states"].append(board.copy().tolist())

    while not game_over:
        move_count += 1
        if not silent:
            print(f"\n轮到玩家 {current_player} (Agent {current_player})")

        current_agent = agents[current_player]

        start_time = time.time()

        is_human_player = hasattr(current_agent, "create_gui")

        if is_human_player:
            try:
                move = current_agent.make_move(board.copy())
                end_time = time.time()
                if not silent:
                    print(
                        f"玩家 {current_player} 落子时间: {end_time - start_time:.4f}秒"
                    )
            except Exception as e:
                if not silent:
                    print(f"玩家 {current_player} 出现异常: {e}")
                winner = 3 - current_player
                game_over = True
                # 记录异常
                if record_moves:
                    move_time = time.time() - start_time
                    game_record["moves"].append(
                        {
                            "move_number": move_count,
                            "player": current_player,
                            "move": None,
                            "time_taken": move_time,
                            "result": "exception",
                            "error": str(e),
                        }
                    )
                    game_record["player_times"].append(move_time)
                break
        else:
            with ThreadPoolExecutor(max_workers=1) as executor:
                try:
                    future = executor.submit(current_agent.make_move, board.copy())
                    move = future.result(timeout=PLAYER_TIME_LIMIT)
                    end_time = time.time()

                    if not silent:
                        print(
                            f"玩家 {current_player} 落子时间: {end_time - start_time:.4f}秒"
                        )

                except FutureTimeoutError:
                    end_time = time.time()
                    if not silent:
                        print(
                            f"玩家 {current_player} 操作超时! 超时时间: {end_time - start_time:.4f}秒"
                        )
                        print(
                            f"超过了 {PLAYER_TIME_LIMIT}秒的时间限制，玩家 {current_player} 败北!"
                        )
                    winner = 3 - current_player
                    game_over = True
                    # 记录超时
                    if record_moves:
                        move_time = end_time - start_time
                        game_record["moves"].append(
                            {
                                "move_number": move_count,
                                "player": current_player,
                                "move": None,
                                "time_taken": move_time,
                                "result": "timeout",
                                "error": f"操作超时，超过{PLAYER_TIME_LIMIT}秒限制",
                            }
                        )
                        game_record["player_times"].append(move_time)
                    break
                except Exception as e:
                    if not silent:
                        print(f"玩家 {current_player} 出现异常: {e}")
                    winner = 3 - current_player
                    game_over = True
                    # 记录异常
                    if record_moves:
                        move_time = time.time() - start_time
                        game_record["moves"].append(
                            {
                                "move_number": move_count,
                                "player": current_player,
                                "move": None,
                                "time_taken": move_time,
                                "result": "exception",
                                "error": str(e),
                            }
                        )
                        game_record["player_times"].append(move_time)
                    break

        if game_over:
            break

        if move is None:
            if not silent:
                print("Agent无法做出有效移动! ")
            winner = 3 - current_player
            # 记录无效移动
            if record_moves:
                move_time = time.time() - start_time
                game_record["moves"].append(
                    {
                        "move_number": move_count,
                        "player": current_player,
                        "move": None,
                        "time_taken": move_time,
                        "result": "invalid_move",
                        "error": "Agent无法做出有效移动",
                    }
                )
                game_record["player_times"].append(move_time)
            break

        row, col = move

        if not is_valid_move(board, row, col):
            winner = 3 - current_player
            if not silent:
                print(f"无效的移动: ({row}, {col}), 对手(Agent {winner})获胜! ")
            # 记录无效移动
            if record_moves:
                move_time = time.time() - start_time
                game_record["moves"].append(
                    {
                        "move_number": move_count,
                        "player": current_player,
                        "move": [row, col],
                        "time_taken": move_time,
                        "result": "invalid_position",
                        "error": f"无效的移动位置: ({row}, {col})",
                    }
                )
                game_record["player_times"].append(move_time)
            break

        make_move(board, row, col, current_player)
        move_time = time.time() - start_time

        # 记录有效移动
        if record_moves:
            move_record = {
                "move_number": move_count,
                "player": current_player,
                "move": [row, col],
                "time_taken": move_time,
                "result": "valid",
            }
            game_record["moves"].append(move_record)
            game_record["player_times"].append(move_time)
            game_record["board_states"].append(board.copy().tolist())

        if not silent:
            print(f"玩家 {current_player} 在 ({row}, {col}) 落子")
            print_board(board)

        if check_win(board, row, col):
            game_over = True
            winner = current_player
            if not silent:
                print(f"玩家 {current_player} 获胜! ")
            # 记录获胜信息
            if record_moves:
                game_record["moves"][-1]["result"] = "winning_move"
        elif is_board_full(board):
            game_over = True
            winner = 0
            if not silent:
                print("游戏平局! ")
            # 记录平局信息
            if record_moves:
                game_record["moves"][-1]["result"] = "draw_move"
        else:
            current_player = 3 - current_player

    # 完成游戏记录
    if record_moves:
        game_record["end_time"] = time.time()
        game_record["duration"] = game_record["end_time"] - game_record["start_time"]
        game_record["winner"] = winner
        game_record["total_moves"] = len(
            [
                m
                for m in game_record["moves"]
                if m["result"] in ["valid", "winning_move", "draw_move"]
            ]
        )
        game_record["average_move_time"] = (
            sum(game_record["player_times"]) / len(game_record["player_times"])
            if game_record["player_times"]
            else 0
        )

        # 计算每个玩家的统计信息
        player_stats = {
            1: {"moves": 0, "total_time": 0},
            2: {"moves": 0, "total_time": 0},
        }
        for move in game_record["moves"]:
            if move["result"] in ["valid", "winning_move", "draw_move"]:
                player = move["player"]
                player_stats[player]["moves"] += 1
                player_stats[player]["total_time"] += move["time_taken"]

        for player in [1, 2]:
            if player_stats[player]["moves"] > 0:
                player_stats[player]["average_time"] = (
                    player_stats[player]["total_time"] / player_stats[player]["moves"]
                )
            else:
                player_stats[player]["average_time"] = 0

        game_record["player_statistics"] = player_stats

    if not silent:
        if winner == 0:
            print("\n游戏结果: 平局! ")
        elif winner:
            print(f"\n游戏结果: 玩家 {winner} 获胜! ")

    if record_moves:
        return winner, game_record
    else:
        return winner


def main():
    """主函数, 演示游戏使用"""
    parser = argparse.ArgumentParser(description="五子棋对战")
    parser.add_argument(
        "-m",
        "--method",
        type=str,
        default="human",
        help="A2算法选择: human(人类) 或 xxx(算法模块名)",
    )
    parser.add_argument("-s", "--size", type=int, default=11, help="棋盘大小")
    args = parser.parse_args()

    board_size = args.size
    print(f"创建 {board_size}x{board_size} 的棋盘")

    from agent import Agent as A1

    agent1 = A1(1)

    if args.method == "human":
        raise NotImplementedError("在服务器上不实现人类玩家")
    else:
        try:
            mod = importlib.import_module(f"{args.method}")
            agent2 = mod.Search(2)
        except Exception as e:
            print(f"无法加载gomoku/{args.method}.py 的Search类: {e}")
            print("请确认该文件存在且有Search类")
            return

    play_game(agent1, agent2, board_size)


if __name__ == "__main__":
    main()
