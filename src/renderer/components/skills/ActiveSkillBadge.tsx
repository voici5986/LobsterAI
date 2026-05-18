import React from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { RootState } from '../../store';
import { toggleActiveSkill } from '../../store/slices/skillSlice';
import SkillIcon from '../icons/SkillIcon';
import XMarkIcon from '../icons/XMarkIcon';

const ActiveSkillBadge: React.FC = () => {
  const dispatch = useDispatch();
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);

  const activeSkills = activeSkillIds
    .map(id => skills.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  if (activeSkills.length === 0) return null;

  const handleRemoveSkill = (e: React.MouseEvent, skillId: string) => {
    e.stopPropagation();
    dispatch(toggleActiveSkill(skillId));
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {activeSkills.map(skill => (
        <button
          type="button"
          key={skill.id}
          onClick={(e) => handleRemoveSkill(e, skill.id)}
          className="group inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-md bg-primary-muted px-2.5 text-[13px] font-normal leading-none text-foreground transition-all hover:bg-primary/15 hover:ring-1 hover:ring-primary/30"
          title={i18nService.t('clearSkill')}
        >
          <span className="relative flex h-4 w-4 shrink-0 items-center justify-center rounded-sm transition-colors group-hover:bg-primary/15">
            <SkillIcon className="h-3.5 w-3.5 text-primary transition-opacity group-hover:opacity-0" />
            <XMarkIcon className="absolute h-3 w-3 text-primary opacity-0 transition-opacity group-hover:opacity-100" />
          </span>
          <span className="min-w-0 truncate">
            {skill.name}
          </span>
        </button>
      ))}
    </div>
  );
};

export default ActiveSkillBadge;
