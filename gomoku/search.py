from agent import Agent
import numpy as np
import random
import time


class Search(Agent):
    def __init__(self, player, mcts_time=8.0, alpha_beta_depth=5, minimax_depth=4):
        """
        初始化三层分层决策架构的搜索算法

        第一层(MCTS): 粗筛层，生成候选移动
        第二层(Alpha-Beta): 精筛层，筛选最优候选
        第三层(Minimax): 决策层，最终精确决策

        @param mcts_time: MCTS搜索时间限制
        @param alpha_beta_depth: Alpha-Beta搜索深度
        @param minimax_depth: Minimax搜索深度
        """
        super().__init__(player)
        self.mcts_time = mcts_time
        self.minimax_depth = minimax_depth
        self.alpha_beta_depth = alpha_beta_depth

    def make_move(self, board):
        """
        三层分层决策架构的主入口

        @param board: 当前棋盘状态
        @return: 最佳移动位置 (row, col)
        """
        self._determine_player(board)
        if self._is_opening(board):
            return self._opening_move(board)
        mcts_candidates = self._layer1_mcts_coarse_filter(board)
        alpha_beta_candidates = self._layer2_alpha_beta_fine_filter(
            board, mcts_candidates
        )
        best_move = self._layer3_minimax_decision(board, alpha_beta_candidates)
        return best_move

    def _determine_player(self, board):
        """确定当前AI是哪个玩家"""
        return self.player

    def _is_opening(self, board):
        """判断是否为开局阶段"""
        return np.sum(board != 0) <= 2

    def _opening_move(self, board):
        """开局移动策略"""
        center = board.shape[0] // 2

        if np.sum(board != 0) == 0:
            return (center, center)
        for offset in [
            (0, 1),
            (1, 0),
            (0, -1),
            (-1, 0),
            (1, 1),
            (1, -1),
            (-1, 1),
            (-1, -1),
        ]:
            row, col = center + offset[0], center + offset[1]
            if (
                0 <= row < board.shape[0]
                and 0 <= col < board.shape[1]
                and board[row][col] == 0
            ):
                return (row, col)
        empty_cells = [
            (i, j)
            for i in range(board.shape[0])
            for j in range(board.shape[1])
            if board[i][j] == 0
        ]
        return random.choice(empty_cells) if empty_cells else None

    def _layer1_mcts_coarse_filter(self, board):
        """
        第一层：MCTS粗筛阶段
        使用MCTS快速探索，生成10-15个有潜力的候选位置
        """
        candidate_moves = self._get_candidate_moves(board)
        if len(candidate_moves) <= 10:
            return candidate_moves
        move_scores = []
        time_per_move = self.mcts_time / min(len(candidate_moves), 20)
        for move in candidate_moves:
            score = self._quick_mcts_evaluate(board, move, time_per_move)
            move_scores.append((move, score))
        move_scores.sort(key=lambda x: x[1], reverse=True)
        top_moves = [move for move, score in move_scores[:15]]
        return top_moves

    def _layer2_alpha_beta_fine_filter(self, board, candidates):
        """
        第二层：Alpha-Beta剪枝精筛阶段
        对候选位置使用Alpha-Beta进行更精确的评估，筛选到3-5个
        """
        if len(candidates) <= 5:
            return candidates
        move_scores = []
        for move in candidates:
            new_board = board.copy()
            new_board[move[0]][move[1]] = self.player
            score = self._alpha_beta(
                new_board,
                self.alpha_beta_depth - 1,
                float("-inf"),
                float("inf"),
                False,
                move,
            )
            move_scores.append((move, score))
        move_scores.sort(key=lambda x: x[1], reverse=True)
        top_moves = [move for move, score in move_scores[:5]]
        return top_moves

    def _layer3_minimax_decision(self, board, candidates):
        """
        第三层：Minimax最终决策阶段
        对最终候选使用详细Minimax进行深度搜索，做出最终决策
        """
        if len(candidates) == 1:
            return candidates[0]

        best_move = candidates[0]
        best_score = float("-inf")

        for move in candidates:
            new_board = board.copy()
            new_board[move[0]][move[1]] = self.player
            score = self._minimax(new_board, self.minimax_depth - 1, False, move)
            if score > best_score:
                best_score = score
                best_move = move

        return best_move

    def _get_candidate_moves(self, board):
        """获取候选移动位置（在已有棋子周围）"""
        if np.sum(board != 0) == 0:
            center = board.shape[0] // 2
            return [(center, center)]

        candidates = set()
        board_size = board.shape[0]

        for i in range(board_size):
            for j in range(board_size):
                if board[i][j] != 0:
                    for di in range(-2, 3):
                        for dj in range(-2, 3):
                            ni, nj = i + di, j + dj
                            if (
                                0 <= ni < board_size
                                and 0 <= nj < board_size
                                and board[ni][nj] == 0
                            ):
                                candidates.add((ni, nj))

        return list(candidates)

    def _quick_mcts_evaluate(self, board, move, time_limit):
        """对单个移动进行快速MCTS评估"""
        new_board = board.copy()
        new_board[move[0]][move[1]] = self.player
        if self._check_win(new_board, move):
            return 100000
        test_board = board.copy()
        test_board[move[0]][move[1]] = self.opponent
        if self._check_win(test_board, move):
            return 50000
        wins = 0
        simulations = 0
        start_time = time.time()
        while time.time() - start_time < time_limit and simulations < 100:
            result = self._simulate_game(new_board, 3 - self.player)
            if result == self.player:
                wins += 1
            simulations += 1
        return wins / max(simulations, 1) * 1000 + self._evaluate_position(
            new_board, move
        )

    def _minimax(self, board, depth, is_maximizing, last_move):
        """Minimax算法实现"""
        if depth == 0 or self._is_game_over(board, last_move):
            return self._evaluate_board(board)
        candidates = self._get_candidate_moves(board)[:10]
        if is_maximizing:
            max_score = float("-inf")
            current_player = self.player
            for move in candidates:
                new_board = board.copy()
                new_board[move[0]][move[1]] = current_player
                score = self._minimax(new_board, depth - 1, False, move)
                max_score = max(max_score, score)
            return max_score
        else:
            min_score = float("inf")
            current_player = self.opponent
            for move in candidates:
                new_board = board.copy()
                new_board[move[0]][move[1]] = current_player
                score = self._minimax(new_board, depth - 1, True, move)
                min_score = min(min_score, score)
            return min_score

    def _alpha_beta(self, board, depth, alpha, beta, is_maximizing, last_move):
        """Alpha-Beta剪枝算法实现"""
        if depth == 0 or self._is_game_over(board, last_move):
            return self._evaluate_board(board)
        candidates = self._get_candidate_moves(board)[:8]
        if is_maximizing:
            max_score = float("-inf")
            current_player = self.player
            for move in candidates:
                new_board = board.copy()
                new_board[move[0]][move[1]] = current_player
                score = self._alpha_beta(new_board, depth - 1, alpha, beta, False, move)
                max_score = max(max_score, score)
                alpha = max(alpha, score)
                if beta <= alpha:
                    break
            return max_score
        else:
            min_score = float("inf")
            current_player = self.opponent
            for move in candidates:
                new_board = board.copy()
                new_board[move[0]][move[1]] = current_player
                score = self._alpha_beta(new_board, depth - 1, alpha, beta, True, move)
                min_score = min(min_score, score)
                beta = min(beta, score)
                if beta <= alpha:
                    break
            return min_score

    def _check_win(self, board, move):
        """检查指定移动是否导致获胜"""
        if move is None:
            return False

        row, col = move
        player = board[row][col]
        directions = [(0, 1), (1, 0), (1, 1), (1, -1)]

        for dx, dy in directions:
            count = 1

            x, y = row + dx, col + dy
            while (
                0 <= x < board.shape[0]
                and 0 <= y < board.shape[1]
                and board[x][y] == player
            ):
                count += 1
                x, y = x + dx, y + dy
            x, y = row - dx, col - dy
            while (
                0 <= x < board.shape[0]
                and 0 <= y < board.shape[1]
                and board[x][y] == player
            ):
                count += 1
                x, y = x - dx, y - dy
            if count >= 4:
                return True

        return False

    def _is_game_over(self, board, last_move):
        """检查游戏是否结束"""
        if last_move and self._check_win(board, last_move):
            return True
        return np.sum(board == 0) == 0

    def _evaluate_board(self, board):
        """评估棋盘状态"""
        return self._evaluate_player(board, self.player) - self._evaluate_player(
            board, self.opponent
        )

    def _evaluate_player(self, board, player):
        """评估特定玩家的棋盘状态"""
        score = 0
        directions = [(0, 1), (1, 0), (1, 1), (1, -1)]

        for i in range(board.shape[0]):
            for j in range(board.shape[1]):
                if board[i][j] == player:
                    for dx, dy in directions:
                        line_score = self._evaluate_line(board, i, j, dx, dy, player)
                        score += line_score

        return score

    def _evaluate_line(self, board, row, col, dx, dy, player):
        """评估从指定位置开始的一条线"""
        count = 0
        blocks = 0

        x, y = row, col
        while (
            0 <= x < board.shape[0]
            and 0 <= y < board.shape[1]
            and board[x][y] == player
        ):
            count += 1
            x, y = x + dx, y + dy
        if (
            x < 0
            or x >= board.shape[0]
            or y < 0
            or y >= board.shape[1]
            or board[x][y] == (3 - player)
        ):
            blocks += 1
        x, y = row - dx, col - dy
        while (
            0 <= x < board.shape[0]
            and 0 <= y < board.shape[1]
            and board[x][y] == player
        ):
            count += 1
            x, y = x - dx, y - dy
        if (
            x < 0
            or x >= board.shape[0]
            or y < 0
            or y >= board.shape[1]
            or board[x][y] == (3 - player)
        ):
            blocks += 1
        if count >= 5:
            return 1000000
        elif count == 4:
            return 100000 if blocks == 0 else (50000 if blocks == 1 else 100)
        elif count == 3:
            return 60000 if blocks == 0 else (1000 if blocks == 1 else 10)
        elif count == 2:
            return 100 if blocks == 0 else (10 if blocks == 1 else 5)
        else:
            return 1

    def _evaluate_position(self, board, move):
        """评估单个位置的价值"""
        row, col = move
        score = 0

        center = board.shape[0] // 2
        distance_to_center = abs(row - center) + abs(col - center)
        score += max(0, 10 - distance_to_center)
        for di in [-1, 0, 1]:
            for dj in [-1, 0, 1]:
                ni, nj = row + di, col + dj
                if (
                    0 <= ni < board.shape[0]
                    and 0 <= nj < board.shape[1]
                    and board[ni][nj] != 0
                ):
                    score += 5
        return score

    def _simulate_game(self, board, current_player):
        """快速游戏模拟"""
        simulation_board = board.copy()
        moves_count = 0
        max_moves = 20

        while moves_count < max_moves:
            candidates = self._get_candidate_moves(simulation_board)
            if not candidates:
                return 0

            move = random.choice(candidates[:5])
            simulation_board[move[0]][move[1]] = current_player

            if self._check_win(simulation_board, move):
                return current_player

            current_player = 3 - current_player
            moves_count += 1

        return 0
