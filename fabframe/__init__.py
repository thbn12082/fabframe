"""fabframe: plug a dispatcher into the SMT2020 fab simulator and run it.

    from fabframe import Dispatcher, run

    class PriorityMinusCR(Dispatcher):
        name = "priority-minus-cr"
        def score(self, lot, decision):
            return lot.priority - lot.cr    # higher runs first

    result = run(PriorityMinusCR(), dataset="HVLM", days=7)
    print(result.kpi["throughput_per_day"])

Built-in rules (Paper 4's set) run by id: run("critical-ratio", ...).
"""

__version__ = "0.1.0"

from .api import DecisionView, Dispatcher, FabInfo, FunctionDispatcher, LotView, MachineView  # noqa: E402
from .runner import DispatcherError, RunResult, run  # noqa: E402

__all__ = [
    "DecisionView", "Dispatcher", "DispatcherError", "FabInfo", "FunctionDispatcher",
    "LotView", "MachineView", "RunResult", "run", "__version__",
]
