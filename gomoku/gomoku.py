import argparse
import importlib
import numpy as np
import time
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError

PLAYER_TIME_LIMIT = 60.0
EMPTY = 0
PLAYER1_STONE = 1
PLAYER2_STONE = 2
PLAYER1_SKILL = 3
PLAYER2_SKILL = 4


def get_skill_marker(player):
    return PLAYER1_SKILL if player == 1 else PLAYER2_SKILL


def is_stone_cell(cell_value):
    return cell_value in (PLAYER1_STONE, PLAYER2_STONE)


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
    return is_valid_position(board, row, col) and board[row][col] == EMPTY


def is_valid_position(board, row, col):
    """
    检查坐标是否在棋盘范围内

    @param board: 棋盘
    @param row: 行坐标
    @param col: 列坐标
    @return: 是否在范围内
    """
    board_size = len(board)
    return 0 <= row < board_size and 0 <= col < board_size


def is_valid_skill_target(board, row, col):
    """
    检查技能释放位置是否合法（允许覆盖技能标记，不允许落在已有棋子上）

    @param board: 棋盘
    @param row: 行坐标
    @param col: 列坐标
    @return: 是否合法
    """
    return is_valid_position(board, row, col) and not is_stone_cell(board[row][col])


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


def clear_block_for_player(board, blocked_cell_for_player, player):
    """
    清除指定玩家的封锁效果和棋盘上的技能标记

    @param board: 棋盘
    @param blocked_cell_for_player: 被封锁格记录
    @param player: 被封锁玩家编号
    """
    blocked_cell = blocked_cell_for_player[player]
    if blocked_cell is None:
        return

    row, col = blocked_cell
    caster = 3 - player
    expected_marker = get_skill_marker(caster)

    if is_valid_position(board, row, col) and board[row][col] == expected_marker:
        board[row][col] = EMPTY

    blocked_cell_for_player[player] = None


def is_board_full(board):
    """
    检查棋盘是否已满

    @param board: 棋盘
    @return: 是否已满
    """
    return np.all((board == PLAYER1_STONE) | (board == PLAYER2_STONE))


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
            if board[i][j] == EMPTY:
                print(" .", end="")
            elif board[i][j] == PLAYER1_STONE:
                print(" ●", end="")
            elif board[i][j] == PLAYER2_STONE:
                print(" ○", end="")
            elif board[i][j] == PLAYER1_SKILL:
                print(" ◇", end="")
            elif board[i][j] == PLAYER2_SKILL:
                print(" ◆", end="")
            else:
                print(" ?", end="")
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
            "skill_casts": [],
            "board_states": [] if record_moves else None,
            "player_times": [],
        }
        if record_moves
        else None
    )

    agents = {1: agent1, 2: agent2}
    skill_used = {1: False, 2: False}
    blocked_cell_for_player = {1: None, 2: None}

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
                move_result = current_agent.make_move(board.copy())
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
                    move_result = future.result(timeout=PLAYER_TIME_LIMIT)
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

        move = None
        skill_target = None
        move_format_error = None

        if isinstance(move_result, tuple) and len(move_result) == 2:
            move, skill_target = move_result
        else:
            move_format_error = "返回值格式错误，应为((row,col), skill_pos|None)"

        if skill_target is not None:
            if skill_used[current_player]:
                if not silent:
                    print(f"玩家 {current_player} 重复释放技能，技能无效但已消耗。")
            else:
                skill_used[current_player] = True

                if (
                    not isinstance(skill_target, (tuple, list))
                    or len(skill_target) != 2
                ):
                    if not silent:
                        print(f"玩家 {current_player} 技能释放格式非法，技能已消耗。")
                else:
                    skill_row, skill_col = skill_target
                    if not is_valid_skill_target(board, skill_row, skill_col):
                        if not silent:
                            print(
                                f"玩家 {current_player} 技能释放非法: ({skill_row}, {skill_col})，技能已消耗。"
                            )
                    else:
                        blocked_cell_for_player[3 - current_player] = (
                            skill_row,
                            skill_col,
                        )
                        board[skill_row][skill_col] = get_skill_marker(current_player)
                        if record_moves:
                            game_record["skill_casts"].append(
                                {
                                    "player": current_player,
                                    "move_number": move_count,
                                    "position": [skill_row, skill_col],
                                }
                            )
                        if not silent:
                            print(
                                f"玩家 {current_player} 释放技能，封锁玩家 {3 - current_player} 下一回合位置 ({skill_row}, {skill_col})"
                            )

        if not (
            isinstance(move, (tuple, list))
            and len(move) == 2
            and isinstance(move[0], (int, np.integer))
            and isinstance(move[1], (int, np.integer))
        ):
            move = None

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
                        "error": move_format_error or "Agent无法做出有效移动",
                    }
                )
                game_record["player_times"].append(move_time)
                game_record["board_states"].append(board.copy().tolist())
            break

        row, col = move

        blocked_cell = blocked_cell_for_player[current_player]
        if blocked_cell is not None and (row, col) == blocked_cell:
            winner = 3 - current_player
            if not silent:
                print(
                    f"玩家 {current_player} 尝试在被封锁位置 ({row}, {col}) 落子，判负! "
                )
            if record_moves:
                move_time = time.time() - start_time
                game_record["moves"].append(
                    {
                        "move_number": move_count,
                        "player": current_player,
                        "move": [row, col],
                        "time_taken": move_time,
                        "result": "blocked_position",
                        "error": f"尝试在被封锁位置落子: ({row}, {col})",
                    }
                )
                game_record["player_times"].append(move_time)
                game_record["board_states"].append(board.copy().tolist())
            break

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
                game_record["board_states"].append(board.copy().tolist())
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
            clear_block_for_player(board, blocked_cell_for_player, current_player)
            if record_moves:
                game_record["board_states"].append(board.copy().tolist())
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
