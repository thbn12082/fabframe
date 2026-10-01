"""Luật tự viết duy nhất Paper 4 từng chạy: ưu tiên trừ tỷ số tới hạn (priority − CR).

Trong Paper 4 đây là đối thủ cố định P4-HEADROOM-SYMBOLIC-PRIORITY-MINUS-CR-v1, một biểu
thức viết tay chứ không phải AI. Ở đây nó chấm từng lot, sau hai chốt của kernel.

    python -m fabframe check examples/priority_minus_cr.py
    python -m fabframe run examples/priority_minus_cr.py --days 7
"""

from fabframe import Dispatcher


class PriorityMinusCR(Dispatcher):
    name = "priority-minus-cr"

    def score(self, lot, decision):
        # Điểm CAO chạy TRƯỚC: ưu tiên càng cao, càng sát hạn (CR càng nhỏ) thì điểm càng cao.
        return lot.priority - lot.cr
