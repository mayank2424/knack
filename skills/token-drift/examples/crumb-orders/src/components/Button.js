import styled from 'styled-components';

export const Button = styled.button`
  padding: 12px 18px;
  border: none;
  border-radius: 6px;
  background: #e8590c;
  color: #ffffff;
  font-size: 15px;
  font-weight: 600;
  transition: background 180ms ease;

  &:hover {
    background: #d9480e;
  }

  &:disabled {
    background: #cccccc;
    color: #666;
  }
`;

export const GhostButton = styled(Button)`
  background: transparent;
  color: #333333;
  border: 1px solid #e5e5e5;
  border-radius: 7px;

  &:hover {
    background: #f5f5f5;
  }
`;
