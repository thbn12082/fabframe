import datetime

from simulation.randomizer import Randomizer

r = Randomizer()


def get_interval(num, unit):
    units = {'sec': 1, 's': 1, 'min': 60, 'hr': 3600, 'day': 86400, 'pieces': 1, '': 1}
    if num is None:
        return None
    if unit in units:
        return num * units[unit]
    else:
        raise ValueError(f'Unit {unit} not known.')


class UniformDistribution:

    supports_semantic_context = True

    def __init__(self, m, l, units='sec'):
        self.m, self.l, self.units = m, l, units

    def sample(self, context=None):
        lower = self.m - self.l / 2
        upper = self.m + self.l / 2
        if context is None:
            return r.random.uniform(lower, upper)
        return r.sample(
            'uniform', {'lower': lower, 'upper': upper}, self.units, context,
            lambda: r.random.uniform(lower, upper)
        )

    def avg(self):
        return self.m


class ConstantDistribution:

    supports_semantic_context = True

    def __init__(self, c):
        self.c = c

    def sample(self, context=None):
        return self.c

    def avg(self):
        return self.c


class ExponentialDistribution:

    supports_semantic_context = True

    def __init__(self, p, units='sec'):
        self.p, self.units = p, units

    def sample(self, context=None):
        if context is None:
            return r.random.expovariate(1 / self.p)
        return r.sample(
            'exponential', {'mean': self.p}, self.units, context,
            lambda: r.random.expovariate(1 / self.p)
        )


def get_distribution(typ, unit, *args, multiplier=1):
    arr = [multiplier * get_interval(a, unit) for a in args if a is not None]
    if typ == 'uniform':
        return UniformDistribution(*arr, units='sec')
    if typ == 'constant':
        return ConstantDistribution(*arr)
    if typ == 'exponential':
        return ExponentialDistribution(*arr, units='sec')


def date_time_parse(st):
    return datetime.datetime.strptime(st, '%m/%d/%y %H:%M:%S')
