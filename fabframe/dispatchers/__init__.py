"""Built-in dispatchers, by id: ``python -m fabframe run critical-ratio``.

The set is Paper 4's, in its D1..D8 order and under its ``GraphRule`` ids,
plus its ``uniform`` lower bound (minimum-batch is missing, see classic.py).
"""

from __future__ import annotations

from typing import Callable, Dict

from ..api import Dispatcher
from .classic import ATC, ATC_CQT, CQTSavableFirst, CR, FIFO, SRPT, SRPT_CQT, Uniform

BUILTINS: Dict[str, Callable[[], Dispatcher]] = {
    "fifo": FIFO,
    "critical-ratio": CR,
    "atc": ATC,
    "srpt": SRPT,
    "atc-cqt": ATC_CQT,
    "srpt-cqt": SRPT_CQT,
    "cqt-savable-first": CQTSavableFirst,
    "uniform": Uniform,
}

# one line per rule, for people: the web UI's tooltips and `fabframe list`
ABOUT: Dict[str, str] = {
    "fifo": "Paper 4 D1, trùng FIFO của kernel: ít setup trước, ưu tiên cao trước, rồi lot sẵn sàng "
            "sớm nhất, rồi hạn sớm nhất.",
    "critical-ratio": "Paper 4 D2, trùng CR của kernel: ít setup trước, ưu tiên cao trước, rồi tỷ số "
                      "tới hạn (hạn − bây giờ) / thời gian gia công còn lại nhỏ nhất.",
    "atc": "Paper 4 D4, Apparent Tardiness Cost, k = 2: lớn nhất trước theo ưu tiên / thời gian bước "
           "× e^(−max(0, hạn − bây giờ − thời gian bước) / (k × thời gian bước trung bình)); hoà thì "
           "hạn sớm hơn, rồi lot đã qua ít bước hơn.",
    "srpt": "Paper 4 D5: ít việc còn lại nhất trước (số wafer × thời gian gia công còn lại); hoà thì "
            "hạn sớm hơn, rồi lot đã qua ít bước hơn.",
    "atc-cqt": "Paper 4 D6: như ATC, nhưng xét trước ít setup rồi ưu tiên cao (tiền tố chung với FIFO, CR).",
    "srpt-cqt": "Paper 4 D7: như SRPT, nhưng xét trước ít setup rồi ưu tiên cao (tiền tố chung với FIFO, CR).",
    "cqt-savable-first": "Paper 4 D8: như FIFO, nhưng trong các lot đang chạy đồng hồ CQT, lot còn kịp hạn "
                         "CQT đi trước lot đã quá hạn.",
    "uniform": "Cận dưới ngẫu nhiên đều của Paper 4: thứ tự ngẫu nhiên, RNG riêng theo seed nên không "
               "đổi sự cố của nhà máy.",
}


def builtin(name: str) -> Dispatcher:
    try:
        return BUILTINS[name]()
    except KeyError:
        raise KeyError("unknown built-in dispatcher %r (have: %s)" % (name, ", ".join(BUILTINS)))
