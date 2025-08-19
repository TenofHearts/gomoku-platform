import argparse
import json
import sys
import os
import importlib.util
import traceback
from pathlib import Path

# 添加gomoku目录到Python路径
current_dir = Path(__file__).parent
gomoku_dir = current_dir / 'gomoku'
sys.path.insert(0, str(gomoku_dir))

try:
    from gomoku import play_game, create_board
    from agent import Agent
except ImportError:
    # 如果导入失败，尝试直接导入
    import sys
    import os
    sys.path.append(os.path.join(os.path.dirname(__file__), 'gomoku'))
    from gomoku import play_game, create_board
    from agent import Agent


class FileAgent(Agent):
    """从文件加载的Agent包装器"""
    def __init__(self, player, file_path):
        super().__init__(player)
        self.file_path = file_path
        self.agent_instance = self._load_agent_from_file()
    
    def _load_agent_from_file(self):
        """从文件加载Agent类"""
        try:
            spec = importlib.util.spec_from_file_location("user_agent", self.file_path)
            module = importlib.util.module_from_spec(spec)
            
            # 确保agent.py在模块中可用
            sys.modules['agent'] = importlib.import_module('agent')
            
            spec.loader.exec_module(module)
            
            # 查找继承自Agent的类
            for attr_name in dir(module):
                attr = getattr(module, attr_name)
                if (isinstance(attr, type) and 
                    issubclass(attr, Agent) and 
                    attr != Agent):
                    return attr(self.player)
            
            raise Exception("未找到继承自Agent的类")
            
        except Exception as e:
            print(f"加载Agent失败: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            # 返回随机Agent作为fallback
            return Agent(self.player)
    
    def make_move(self, board):
        """代理make_move调用"""
        try:
            return self.agent_instance.make_move(board)
        except Exception as e:
            print(f"Agent执行失败: {e}", file=sys.stderr)
            # 返回随机移动作为fallback
            return super().make_move(board)


def run_multiple_games(agent1_path, agent2_path, num_games=10):
    """运行多局比赛并返回结果"""
    challenger_wins = 0
    defender_wins = 0
    
    results = []
    
    for game_num in range(num_games):
        try:
            # 每局比赛创建新的Agent实例
            if agent1_path.endswith('agent.py'):
                # 默认随机Agent
                agent1 = Agent(1)
            else:
                agent1 = FileAgent(1, agent1_path)
            
            if agent2_path.endswith('agent.py'):
                # 默认随机Agent
                agent2 = Agent(2)
            else:
                agent2 = FileAgent(2, agent2_path)
            
            # 运行游戏
            winner = play_single_game_silent(agent1, agent2)
            
            game_result = {
                'game': game_num + 1,
                'winner': winner,
                'player1': 'challenger',
                'player2': 'defender'
            }
            
            if winner == 1:
                challenger_wins += 1
            elif winner == 2:
                defender_wins += 1
            # winner == 0 表示平局，不计入胜负
            
            results.append(game_result)
            
        except Exception as e:
            print(f"第{game_num + 1}局比赛出错: {e}", file=sys.stderr)
            # 出错时认为挑战者失败
            defender_wins += 1
            results.append({
                'game': game_num + 1,
                'winner': 2,
                'error': str(e)
            })
    
    # 确定最终胜者
    if challenger_wins > defender_wins:
        winner = 'challenger'
    elif defender_wins > challenger_wins:
        winner = 'defender'
    else:
        winner = 'tie'
    
    return {
        'winner': winner,
        'challenger_wins': challenger_wins,
        'defender_wins': defender_wins,
        'total_games': num_games,
        'games': results
    }


def play_single_game_silent(agent1, agent2, board_size=15):
    """静默运行单局游戏，不输出过程信息"""
    board = create_board(board_size)
    current_player = 1
    game_over = False
    winner = None
    
    agents = {1: agent1, 2: agent2}
    max_moves = board_size * board_size  # 防止无限循环
    move_count = 0
    
    while not game_over and move_count < max_moves:
        current_agent = agents[current_player]
        
        try:
            move = current_agent.make_move(board.copy())
            move_count += 1
            
            if move is None:
                # Agent无法移动，对手获胜
                winner = 3 - current_player
                break
            
            row, col = move
            
            # 验证移动有效性
            if not (0 <= row < board_size and 0 <= col < board_size and board[row][col] == 0):
                # 无效移动，对手获胜
                winner = 3 - current_player
                break
            
            # 执行移动
            board[row][col] = current_player
            
            # 检查胜利
            if check_win_simple(board, row, col):
                winner = current_player
                break
            
            # 检查平局
            if move_count >= board_size * board_size or is_board_full_simple(board):
                winner = 0  # 平局
                break
            
            # 切换玩家
            current_player = 3 - current_player
            
        except Exception as e:
            # Agent出错，对手获胜
            print(f"玩家{current_player}出错: {e}", file=sys.stderr)
            winner = 3 - current_player
            break
    
    return winner


def check_win_simple(board, row, col):
    """简化的胜利检查"""
    board_size = len(board)
    player = board[row][col]
    
    directions = [(0, 1), (1, 0), (1, 1), (1, -1)]
    
    for dx, dy in directions:
        count = 1
        
        # 正方向
        x, y = row + dx, col + dy
        while 0 <= x < board_size and 0 <= y < board_size and board[x][y] == player:
            count += 1
            x, y = x + dx, y + dy
        
        # 负方向
        x, y = row - dx, col - dy
        while 0 <= x < board_size and 0 <= y < board_size and board[x][y] == player:
            count += 1
            x, y = x - dx, y - dy
        
        if count >= 5:
            return True
    
    return False


def is_board_full_simple(board):
    """简化的棋盘满检查"""
    for row in board:
        for cell in row:
            if cell == 0:
                return False
    return True


def main():
    parser = argparse.ArgumentParser(description='五子棋AI对战')
    parser.add_argument('--challenger', required=True, help='挑战者AI文件路径')
    parser.add_argument('--defender', required=True, help='应战者AI文件路径')
    parser.add_argument('--games', type=int, default=10, help='比赛局数')
    
    args = parser.parse_args()
    
    # 验证文件存在
    if not os.path.exists(args.challenger):
        print(f"挑战者文件不存在: {args.challenger}", file=sys.stderr)
        sys.exit(1)
    
    if not os.path.exists(args.defender):
        print(f"应战者文件不存在: {args.defender}", file=sys.stderr)
        sys.exit(1)
    
    # 运行比赛
    try:
        result = run_multiple_games(args.challenger, args.defender, args.games)
        
        # 输出JSON结果
        print(json.dumps(result, ensure_ascii=False, indent=2))
        
    except Exception as e:
        error_result = {
            'winner': 'defender',
            'challenger_wins': 0,
            'defender_wins': args.games,
            'total_games': args.games,
            'error': str(e)
        }
        print(json.dumps(error_result, ensure_ascii=False, indent=2))
        sys.exit(1)


if __name__ == "__main__":
    main()
