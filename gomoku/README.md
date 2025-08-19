# 基于搜索的人工智能: 五子棋AI

本次实验中, 你将要实现一个基于搜索的五子棋AI, 并且能够在提供的环境中进行对弈. 

本次实验中包含以下几个文件: 

```bash
gomoku/
├── gomoku.py  # 包含五子棋的环境
├── agent.py   # 所有五子棋AI的基类, 实现了一个随机下棋的算法
└── human.py   # 实现了一个由人类下棋的接口
```

## 实验环境

在 `gomoku.py` 中实现了一个五子棋的游戏逻辑, 实现了游戏胜利的判断, 棋盘(11$\times$11)的维护等简单功能. 你实现的搜索算法的 `make_move` 方法会在这个文件中被调用, 返回下一步下棋的位置 `(x, y)` . 

**在本次实验中, 你不应该修改该文件中的内容.**

## 实现要求

在本次实验中, 你需要实现一个基于搜索的五子棋AI算法, 并且有以下要求: 
- 你需要实现一个叫做 `Search` 的类, 并在其中实现你的搜索算法
- 你实现是 `Search` 类必须继承自 `Agent` 类(在 `agent.py` 中)
- 你需要重写 `Search` 类的 `make_move` 方法, 其接受一个棋盘作为输入, 输出一个元组 `(x, y)` 代表下棋的位置. 
- 你的算法不应该调用除了 `numpy` 之外的任何库
- 你的算法搜索时间不应该长于**一分钟**
- 不要做并行搜索(毕竟写并发代码挺麻烦的, 且并不是这门课的重点)

## 思路提示

五子棋AI的设计应该分为两部分, 搜索算法的设计以及评估函数的设计: 

- 五子棋本质是一个零和博弈游戏, 而五子棋AI则是一个决策树搜索问题. 显然, 遍历整个决策树不切实际的, 因此, 如何搜索, 搜索多深就是这次作业中同学们需要解决的核心问题. 
- 在搜索出某个局面时, 如何判断这个局面的价值是一个值得研究的问题. 同学们最直观的想法通常已经足够有效, 但也有一些更加复杂的评估函数值得去探索. 

<!-- ### 基础搜索算法
- DFS (深度优先搜索)
- BFS (广度优先搜索)
- A* (A星搜索算法)

### 博弈搜索算法
- Minimax (极小化极大算法)
- Alpha Beta (Alpha-Beta剪枝)
- Negamax (负极大值算法)
- Monte Carlo Tree Search (MCTS, 蒙特卡洛树搜索)

### 五子棋专用算法
- Principal Variation Search (PVS, 主要变例搜索)
- Iterative Deepening (迭代加深搜索)
- Threat Space Search (威胁空间搜索)
- Pattern Recognition (模式识别)

### 优化技术
- Transposition Table (置换表)
- Move Ordering (走法排序)
- Killer Move Heuristic (杀手启发式)
- History Heuristic (历史启发式)
- Null Move Pruning (空着剪枝)
- Quiescence Search 

### 评估函数设计
- Material Evaluation (子力评估)
- Positional Evaluation (位置评估)
- Pattern-based Evaluation (基于模式的评估)
- Threat-based Evaluation (基于威胁的评估) -->

## 提交要求

TBD