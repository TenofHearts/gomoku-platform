#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
学生信息导入脚本
从CSV文件读取学生信息并添加到students.json中
"""

import csv
import json
import bcrypt
import os
from datetime import datetime, timezone


def hash_password(password):
    """使用bcrypt对密码进行哈希，与server.js中的方式保持一致"""
    # 生成salt并哈希密码，rounds=10与server.js保持一致
    salt = bcrypt.gensalt(rounds=10)
    hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
    return hashed.decode('utf-8')


def read_csv_file(csv_path):
    """读取CSV文件并解析学生信息"""
    students = []
    
    with open(csv_path, 'r', encoding='utf-8') as file:
        # 跳过前几行标题行，找到真正的数据开始位置
        lines = file.readlines()
        
        # 查找包含"序号,学号,姓名"的行
        header_line_index = -1
        for i, line in enumerate(lines):
            if '序号,学号,姓名' in line:
                header_line_index = i
                break
        
        if header_line_index == -1:
            print("未找到表头行，请检查CSV文件格式")
            return students
        
        # 从表头行的下一行开始解析数据
        data_lines = lines[header_line_index + 1:]
        
        for line_num, line in enumerate(data_lines, start=header_line_index + 2):
            line = line.strip()
            
            # 跳过空行或无效行
            if not line or line.startswith(',,,'):
                continue
                
            # 分割CSV行
            parts = line.split(',')
            
            # 确保至少有3列数据（序号、学号、姓名）
            if len(parts) >= 3:
                try:
                    seq_num = parts[0].strip()
                    student_id = parts[1].strip()
                    student_name = parts[2].strip()
                    
                    # 验证数据有效性
                    if seq_num.isdigit() and student_id and student_name:
                        students.append({
                            'student_id': student_id,
                            'name': student_name
                        })
                        print(f"解析学生: {student_id} - {student_name}")
                    else:
                        if seq_num or student_id or student_name:  # 只对非空行报告
                            print(f"第{line_num}行数据格式不正确，跳过: {line[:50]}...")
                        
                except Exception as e:
                    print(f"第{line_num}行解析失败: {e}")
                    continue
    
    return students


def load_existing_students(json_path):
    """加载现有的学生数据"""
    if os.path.exists(json_path):
        try:
            with open(json_path, 'r', encoding='utf-8') as file:
                return json.load(file)
        except Exception as e:
            print(f"读取现有students.json失败: {e}")
            return {}
    return {}


def save_students_json(json_path, students_data):
    """保存学生数据到JSON文件"""
    try:
        with open(json_path, 'w', encoding='utf-8') as file:
            json.dump(students_data, file, ensure_ascii=False, indent=4)
        print(f"学生数据已保存到: {json_path}")
        return True
    except Exception as e:
        print(f"保存students.json失败: {e}")
        return False


def main():
    """主函数"""
    # 文件路径
    csv_path = './data/点名册.csv'
    json_path = './data/students.json'
    
    print("开始导入学生信息...")
    print("=" * 50)
    
    # 检查CSV文件是否存在
    if not os.path.exists(csv_path):
        print(f"错误: CSV文件不存在: {csv_path}")
        return
    
    # 读取CSV文件
    print("正在读取CSV文件...")
    csv_students = read_csv_file(csv_path)
    
    if not csv_students:
        print("未从CSV文件中读取到任何学生信息")
        return
    
    print(f"从CSV文件读取到 {len(csv_students)} 条学生记录")
    
    # 加载现有的学生数据
    print("正在加载现有学生数据...")
    existing_students = load_existing_students(json_path)
    print(f"现有学生数据: {len(existing_students)} 条记录")
    
    # 默认密码
    default_password = "123456"
    current_time = datetime.now(timezone.utc).isoformat()
    
    # 添加新学生
    added_count = 0
    updated_count = 0
    
    print("\n正在处理学生数据...")
    print("-" * 30)
    
    for student in csv_students:
        student_id = student['student_id']
        student_name = student['name']
        
        if student_id in existing_students:
            # 更新现有学生的姓名（如果不同）
            if existing_students[student_id].get('name') != student_name:
                existing_students[student_id]['name'] = student_name
                updated_count += 1
                print(f"更新学生姓名: {student_id} -> {student_name}")
        else:
            # 添加新学生
            hashed_password = hash_password(default_password)
            existing_students[student_id] = {
                "password": hashed_password,
                "name": student_name,
                "created_at": current_time
            }
            added_count += 1
            print(f"添加新学生: {student_id} - {student_name}")
    
    # 保存更新后的数据
    print("\n" + "=" * 50)
    print(f"处理完成:")
    print(f"  新增学生: {added_count} 个")
    print(f"  更新学生: {updated_count} 个")
    print(f"  总计学生: {len(existing_students)} 个")
    
    if added_count > 0 or updated_count > 0:
        if save_students_json(json_path, existing_students):
            print("✅ 学生信息导入成功!")
        else:
            print("❌ 保存文件失败!")
    else:
        print("ℹ️  没有需要更新的数据")
    
    print(f"\n默认密码: {default_password}")
    print("建议学生首次登录后及时修改密码")


if __name__ == "__main__":
    main()
